/**
 * trader-routes/index.ts
 *
 * Barrel router: mounts each per-concern sub-router at the same root so
 * the absolute /api/v1/trader/... paths declared inside each module stay
 * byte-for-byte identical to the pre-split single-file layout.
 */

import { Router } from 'express'
import statusRoutes from './status.js'
import strategiesRoutes from './strategies.js'
import verdictsRoutes from './verdicts.js'
import committeeRoutes from './committee.js'
import auditLogRoutes from './audit-log.js'

const router = Router()

router.use(statusRoutes)
router.use(strategiesRoutes)
router.use(verdictsRoutes)
router.use(committeeRoutes)
router.use(auditLogRoutes)

export default router
