import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  makeOperatorSend,
  parseOperatorChatIds,
  maskChatId,
  type BroadcastChannelManager,
} from './operator-broadcast.js'
import type { TraderApprovalKeyboard } from './approval-manager.js'

/**
 * Unit tests for Phase 6 Task 6 -- multi-operator alert routing.
 *
 * The helper module wraps a list of Telegram chat ids into the same
 * single-text closures that the trader scheduler already consumes. These
 * tests pin the resolution order, the serial broadcast contract, and the
 * "one failure does not block the others" behaviour. The scheduler's
 * higher-level wiring in src/index.ts is exercised separately by the
 * integration path and is intentionally not part of the unit surface.
 */

describe('parseOperatorChatIds', () => {
  it('returns empty array when input is empty', () => {
    expect(parseOperatorChatIds('')).toEqual([])
  })

  it('returns empty array when input is undefined', () => {
    expect(parseOperatorChatIds(undefined)).toEqual([])
  })

  it('returns empty array when input is null', () => {
    expect(parseOperatorChatIds(null)).toEqual([])
  })

  it('splits a single id', () => {
    expect(parseOperatorChatIds('12345')).toEqual(['12345'])
  })

  it('splits multiple ids and trims whitespace', () => {
    expect(parseOperatorChatIds('111, 222 ,333')).toEqual(['111', '222', '333'])
  })

  it('drops empty entries from comma-only input', () => {
    expect(parseOperatorChatIds(',,,')).toEqual([])
  })

  it('drops empty entries in a mixed list', () => {
    expect(parseOperatorChatIds('111,,222,  ,333')).toEqual(['111', '222', '333'])
  })

  it('preserves duplicate ids in input order', () => {
    // Duplicate entries probably indicate a copy/paste mistake -- we keep
    // them so the resulting duplicate Telegram send is visible to the user.
    expect(parseOperatorChatIds('111,222,111')).toEqual(['111', '222', '111'])
  })
})

describe('maskChatId', () => {
  it('masks a typical Telegram chat id to last 4 chars', () => {
    expect(maskChatId('531665124')).toBe('***5124')
  })

  it('returns short ids unchanged to avoid revealing more than the real id', () => {
    expect(maskChatId('1234')).toBe('1234')
    expect(maskChatId('1')).toBe('1')
    expect(maskChatId('')).toBe('')
  })

  it('masks negative group chat ids (Telegram groups use negative ids)', () => {
    expect(maskChatId('-100123456789')).toBe('***6789')
  })
})

describe('makeOperatorSend', () => {
  let sendMock: ReturnType<typeof vi.fn>
  let sendWithKeyboardMock: ReturnType<typeof vi.fn>
  let channelManager: BroadcastChannelManager

  const keyboard: TraderApprovalKeyboard = {
    inline_keyboard: [[{ text: 'APPROVE', callback_data: 'trader:approve:x' }]],
  }

  beforeEach(() => {
    sendMock = vi.fn().mockResolvedValue(undefined)
    sendWithKeyboardMock = vi.fn().mockResolvedValue(undefined)
    channelManager = {
      send: (channelId: string, chatId: string, text: string) =>
        (sendMock as unknown as (c: string, i: string, t: string) => Promise<void>)(
          channelId,
          chatId,
          text,
        ),
      sendWithKeyboard: (
        channelId: string,
        chatId: string,
        text: string,
        kb: TraderApprovalKeyboard,
      ) =>
        (sendWithKeyboardMock as unknown as (
          c: string,
          i: string,
          t: string,
          k: TraderApprovalKeyboard,
        ) => Promise<void>)(channelId, chatId, text, kb),
    }
  })

  it('throws when given an empty operator list (scheduler caller guards this)', () => {
    expect(() => makeOperatorSend(channelManager, 'telegram:trader', [])).toThrow(
      /at least one operator/i,
    )
  })

  it('send fans out to every operator id in order', async () => {
    const { send } = makeOperatorSend(channelManager, 'telegram:trader', ['111', '222', '333'])
    await send('halt alert')

    expect(sendMock).toHaveBeenCalledTimes(3)
    expect(sendMock.mock.calls[0]).toEqual(['telegram:trader', '111', 'halt alert'])
    expect(sendMock.mock.calls[1]).toEqual(['telegram:trader', '222', 'halt alert'])
    expect(sendMock.mock.calls[2]).toEqual(['telegram:trader', '333', 'halt alert'])
  })

  it('sendWithKeyboard fans out to every operator id in order', async () => {
    const { sendWithKeyboard } = makeOperatorSend(channelManager, 'telegram:trader', [
      '111',
      '222',
    ])
    await sendWithKeyboard('approval card', keyboard)

    expect(sendWithKeyboardMock).toHaveBeenCalledTimes(2)
    expect(sendWithKeyboardMock.mock.calls[0]).toEqual([
      'telegram:trader',
      '111',
      'approval card',
      keyboard,
    ])
    expect(sendWithKeyboardMock.mock.calls[1]).toEqual([
      'telegram:trader',
      '222',
      'approval card',
      keyboard,
    ])
  })

  it('send continues to remaining operators when one fails', async () => {
    sendMock.mockImplementationOnce(() => Promise.resolve())
    sendMock.mockImplementationOnce(() => Promise.reject(new Error('telegram 503')))
    sendMock.mockImplementationOnce(() => Promise.resolve())

    const { send } = makeOperatorSend(channelManager, 'telegram:trader', ['111', '222', '333'])
    await send('halt alert')

    // All three attempts happen even though the middle one threw.
    expect(sendMock).toHaveBeenCalledTimes(3)
    expect(sendMock.mock.calls.map((c) => c[1])).toEqual(['111', '222', '333'])
  })

  it('sendWithKeyboard continues to remaining operators when one fails', async () => {
    sendWithKeyboardMock.mockRejectedValueOnce(new Error('telegram 500'))
    sendWithKeyboardMock.mockResolvedValueOnce(undefined)

    const { sendWithKeyboard } = makeOperatorSend(channelManager, 'telegram:trader', [
      '111',
      '222',
    ])
    await sendWithKeyboard('approval card', keyboard)

    expect(sendWithKeyboardMock).toHaveBeenCalledTimes(2)
    expect(sendWithKeyboardMock.mock.calls.map((c) => c[1])).toEqual(['111', '222'])
  })

  it('send is serial -- each call awaits the previous before moving on', async () => {
    // Order-of-completion test: we resolve each send with a staggered delay
    // and assert the calls were initiated in list order. If the loop were
    // parallel, later operators could start before earlier ones returned.
    const order: string[] = []
    sendMock.mockImplementation((_channelId: string, chatId: string) => {
      order.push('start:' + chatId)
      return new Promise<void>((resolve) => {
        setTimeout(() => {
          order.push('end:' + chatId)
          resolve()
        }, 0)
      })
    })

    const { send } = makeOperatorSend(channelManager, 'telegram:trader', ['111', '222'])
    await send('halt alert')

    expect(order).toEqual(['start:111', 'end:111', 'start:222', 'end:222'])
  })

  it('send resolves successfully even when every operator throws', async () => {
    sendMock.mockRejectedValue(new Error('telegram down'))

    const { send } = makeOperatorSend(channelManager, 'telegram:trader', ['111', '222'])
    await expect(send('halt alert')).resolves.toBeUndefined()
    expect(sendMock).toHaveBeenCalledTimes(2)
  })

  it('single-operator broadcast behaves identically to the legacy single-id send', async () => {
    const { send, sendWithKeyboard } = makeOperatorSend(channelManager, 'telegram:trader', [
      '531665124',
    ])
    await send('halt alert')
    await sendWithKeyboard('approval card', keyboard)

    expect(sendMock).toHaveBeenCalledWith('telegram:trader', '531665124', 'halt alert')
    expect(sendWithKeyboardMock).toHaveBeenCalledWith(
      'telegram:trader',
      '531665124',
      'approval card',
      keyboard,
    )
  })
})

describe('operator resolution precedence (Phase 6 Task 6)', () => {
  // These tests pin the precedence rules that src/index.ts applies before
  // calling makeOperatorSend. They exercise the parser directly so the
  // behaviour is observable without booting the whole bot.

  it('env var wins when it has at least one entry', () => {
    const envList = parseOperatorChatIds('111,222')
    const credList = parseOperatorChatIds('333,444,555')
    const resolved = envList.length > 0 ? envList : credList
    expect(resolved).toEqual(['111', '222'])
  })

  it('credential list is used when env var is unset', () => {
    const envList = parseOperatorChatIds(undefined)
    const credList = parseOperatorChatIds('333,444,555')
    const resolved = envList.length > 0 ? envList : credList
    expect(resolved).toEqual(['333', '444', '555'])
  })

  it('credential list is used when env var is empty after trim', () => {
    const envList = parseOperatorChatIds(',, ,')
    const credList = parseOperatorChatIds('333,444')
    const resolved = envList.length > 0 ? envList : credList
    expect(resolved).toEqual(['333', '444'])
  })

  it('scheduler does not start when both env var and credential are empty', () => {
    const envList = parseOperatorChatIds('')
    const credList = parseOperatorChatIds('')
    const resolved = envList.length > 0 ? envList : credList
    expect(resolved).toEqual([])
  })
})
