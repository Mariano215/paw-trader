import type { TraderApprovalKeyboard } from './approval-manager.js'
import { logger } from '../logger.js'

/**
 * Minimal surface of ChannelManager that the broadcast closures rely on.
 * Accepting the interface instead of the class keeps this module easy to
 * test with a plain mock object.
 */
export interface BroadcastChannelManager {
  send(channelId: string, chatId: string, text: string): Promise<void>
  sendWithKeyboard(
    channelId: string,
    chatId: string,
    text: string,
    keyboard: TraderApprovalKeyboard,
  ): Promise<void>
}

export interface OperatorSendFns {
  /** Plain-text broadcast (engine halts, alerts, timeout notices). */
  send: (text: string) => Promise<void>
  /** Approval card broadcast with inline keyboard. */
  sendWithKeyboard: (text: string, keyboard: TraderApprovalKeyboard) => Promise<void>
}

/**
 * Parse a raw comma-separated operator chat id list. Trims whitespace,
 * drops empty entries, and returns the resulting string array. Duplicates
 * are preserved in input order because a user could deliberately repeat an
 * id (the cost of doing so is a duplicate Telegram message, which is a
 * visible operator bug; silently de-duping would hide it).
 */
export function parseOperatorChatIds(raw: string | undefined | null): string[] {
  if (!raw) return []
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

/**
 * Mask a Telegram chat id for safe logging. Shows only the last four
 * characters prefixed with '***'. Short ids (less than 4 chars) are
 * returned unchanged so the mask never reveals more than the real id.
 */
export function maskChatId(chatId: string): string {
  if (chatId.length <= 4) return chatId
  return '***' + chatId.slice(-4)
}

/**
 * Build the pair of broadcast closures that the trader scheduler consumes.
 *
 * Every send iterates the `operatorIds` list serially and calls through to
 * `channelManager`. A failure for one operator is logged as a warning and
 * the iteration continues so the remaining operators still receive the
 * message. The overall contract is "best effort per operator" -- the
 * returned promise resolves after we have attempted every id.
 *
 * Serial (not parallel) iteration is deliberate: channel managers already
 * queue per-chat sends, and sequential fan-out keeps the log ordering
 * predictable for audit purposes. The broadcast is also small enough
 * (operator count in the single digits) that parallelism would not
 * meaningfully change wall time.
 */
export function makeOperatorSend(
  channelManager: BroadcastChannelManager,
  channelId: string,
  operatorIds: readonly string[],
): OperatorSendFns {
  if (operatorIds.length === 0) {
    throw new Error('makeOperatorSend requires at least one operator chat id')
  }

  const send = async (text: string): Promise<void> => {
    for (const chatId of operatorIds) {
      try {
        await channelManager.send(channelId, chatId, text)
      } catch (err) {
        logger.warn(
          { err, channelId, chatId: maskChatId(chatId) },
          'Trader operator broadcast failed for one recipient, continuing',
        )
      }
    }
  }

  const sendWithKeyboard = async (
    text: string,
    keyboard: TraderApprovalKeyboard,
  ): Promise<void> => {
    for (const chatId of operatorIds) {
      try {
        await channelManager.sendWithKeyboard(channelId, chatId, text, keyboard)
      } catch (err) {
        logger.warn(
          { err, channelId, chatId: maskChatId(chatId) },
          'Trader operator approval broadcast failed for one recipient, continuing',
        )
      }
    }
  }

  return { send, sendWithKeyboard }
}
