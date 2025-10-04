"use strict"

Object.defineProperty(exports, "__esModule", { value: true })

const lru_cache_1 = require("lru-cache")
const WABinary_1 = require("../WABinary")

class LIDMappingStore {
    constructor(keys, onWhatsAppFunc, logger) {
        this.mappingCache = new lru_cache_1.LRUCache({
            max: 10000, // Limite massimo di entry in cache
            ttl: 7 * 24 * 60 * 60 * 1000, // 7 giorni
            ttlAutopurge: true,
            updateAgeOnGet: true,
            ttlResolution: 60 * 1000 // Risoluzione TTL di 1 minuto
        })
        
        this.keys = keys
        this.logger = logger
        this.onWhatsAppFunc = onWhatsAppFunc
        this.batchOperations = new Map() // Per operazioni batch
        this.syncInProgress = new Set() // Per evitare richieste duplicate
    }

    /**
     * Store LID-PN mappings in batch with validation migliorata
     */
    async storeLIDPNMappings(pairs, options = {}) {
        const { 
            forceUpdate = false, 
            skipCache = false,
            batchId = Date.now().toString() 
        } = options

        const validPairs = []
        const cacheUpdates = {}
        const dbUpdates = {}
        const logger = this.logger

        // Fase 1: Validazione e preparazione dati
        for (const { lid, pn } of pairs) {
            if (!this.isValidLIDPNPair(lid, pn)) {
                logger.warn(`Invalid LID-PN mapping: ${lid}, ${pn}`)
                continue
            }

            const { lidUser, pnUser } = this.extractUserParts(lid, pn)
            if (!lidUser || !pnUser) continue

            // Controllo esistenza mapping
            if (!forceUpdate) {
                const existing = await this.getExistingMapping(pnUser, lidUser)
                if (existing.exists && existing.matches) {
                    logger.debug({ pnUser, lidUser }, 'LID mapping already exists, skipping')
                    continue
                }
            }

            validPairs.push({ lidUser, pnUser })
            cacheUpdates[`pn:${pnUser}`] = lidUser
            cacheUpdates[`lid:${lidUser}`] = pnUser
            
            dbUpdates[pnUser] = lidUser
            dbUpdates[`${lidUser}_reverse`] = pnUser
        }

        if (validPairs.length === 0) {
            logger.debug('No valid mappings to store')
            return { stored: 0 }
        }

        logger.trace({ 
            batchId, 
            validCount: validPairs.length,
            totalPairs: pairs.length 
        }, `Processing LID mappings batch`)

        // Fase 2: Transazione database
        try {
            await this.keys.transaction(async () => {
                await this.keys.set({
                    'lid-mapping': dbUpdates
                })
            }, 'lid-mapping')

            // Fase 3: Aggiornamento cache (se non skip)
            if (!skipCache) {
                Object.entries(cacheUpdates).forEach(([key, value]) => {
                    this.mappingCache.set(key, value)
                })
            }

            logger.debug({ 
                batchId, 
                stored: validPairs.length 
            }, 'Successfully stored LID mappings')

            return { stored: validPairs.length, batchId }

        } catch (error) {
            logger.error({ error, batchId }, 'Failed to store LID mappings')
            throw error
        }
    }

    /**
     * Get LID for PN con cache migliorata e fallback
     */
    async getLIDForPN(pn, options = {}) {
        const { 
            skipUSync = false, 
            deviceAware = true,
            useCache = true
        } = options

        if (!WABinary_1.isJidUser(pn)) {
            this.logger.warn({ pn }, 'Invalid PN JID format')
            return null
        }

        const decoded = WABinary_1.jidDecode(pn)
        if (!decoded) return null

        const pnUser = decoded.user
        const pnDevice = deviceAware ? (decoded.device ?? 0) : 0

        // Tentativo 1: Cache
        let lidUser = useCache ? this.mappingCache.get(`pn:${pnUser}`) : null

        // Tentativo 2: Database
        if (!lidUser) {
            lidUser = await this.getMappingFromDB(`pn:${pnUser}`)
            if (lidUser && useCache) {
                this.mappingCache.set(`pn:${pnUser}`, lidUser)
            }
        }

        // Tentativo 3: USync (se consentito)
        if (!lidUser && !skipUSync) {
            lidUser = await this.fetchLIDFromUSync(pn, pnUser)
        }

        if (!this.isValidUser(lidUser)) {
            this.logger.debug({ pn, lidUser }, 'No valid LID mapping found')
            return null
        }

        const deviceSpecificLid = `${lidUser}:${pnDevice}@lid`
        
        this.logger.trace({ 
            pn, 
            lid: deviceSpecificLid,
            source: lidUser ? 'mapping' : 'not_found'
        }, 'LID resolution result')

        return deviceSpecificLid
    }

    /**
     * Get PN for LID con gestione device migliorata
     */
    async getPNForLID(lid, options = {}) {
        const { 
            deviceAware = true, 
            useCache = true 
        } = options

        if (!WABinary_1.isLidUser(lid)) {
            this.logger.warn({ lid }, 'Invalid LID format')
            return null
        }

        const decoded = WABinary_1.jidDecode(lid)
        if (!decoded) return null

        const lidUser = decoded.user
        const lidDevice = deviceAware ? (decoded.device ?? 0) : 0

        // Tentativo 1: Cache
        let pnUser = useCache ? this.mappingCache.get(`lid:${lidUser}`) : null

        // Tentativo 2: Database
        if (!pnUser) {
            pnUser = await this.getMappingFromDB(`${lidUser}_reverse`)
            if (pnUser && useCache) {
                this.mappingCache.set(`lid:${lidUser}`, pnUser)
            }
        }

        if (!this.isValidUser(pnUser)) {
            this.logger.debug({ lid, pnUser }, 'No valid PN mapping found')
            return null
        }

        const pnJid = `${pnUser}:${lidDevice}@s.whatsapp.net`
        
        this.logger.trace({ 
            lid, 
            pn: pnJid,
            source: pnUser ? 'mapping' : 'not_found'
        }, 'PN resolution result')

        return pnJid
    }

    /**
     * Bulk resolution per multiple PN/LID
     */
    async bulkResolvePNs(pns, options = {}) {
        const results = {}
        const pendingResolutions = []

        for (const pn of pns) {
            if (results[pn] !== undefined) continue

            pendingResolutions.push(
                this.getLIDForPN(pn, options)
                    .then(lid => { results[pn] = lid })
                    .catch(error => {
                        this.logger.error({ pn, error }, 'Bulk resolution failed')
                        results[pn] = null
                    })
            )
        }

        await Promise.allSettled(pendingResolutions)
        return results
    }

    async bulkResolveLIDs(lids, options = {}) {
        const results = {}
        const pendingResolutions = []

        for (const lid of lids) {
            if (results[lid] !== undefined) continue

            pendingResolutions.push(
                this.getPNForLID(lid, options)
                    .then(pn => { results[lid] = pn })
                    .catch(error => {
                        this.logger.error({ lid, error }, 'Bulk resolution failed')
                        results[lid] = null
                    })
            )
        }

        await Promise.allSettled(pendingResolutions)
        return results
    }

    /**
     * Gestione cache avanzata
     */
    preloadMappings(mappings) {
        let loaded = 0
        for (const { pn, lid } of mappings) {
            if (this.isValidLIDPNPair(pn, lid)) {
                const { lidUser, pnUser } = this.extractUserParts(lid, pn)
                this.mappingCache.set(`pn:${pnUser}`, lidUser)
                this.mappingCache.set(`lid:${lidUser}`, pnUser)
                loaded++
            }
        }
        this.logger.debug({ loaded }, 'Preloaded mappings into cache')
    }

    clearCache(pattern = null) {
        if (!pattern) {
            this.mappingCache.clear()
            this.logger.debug('Cleared entire LID mapping cache')
        } else {
            let cleared = 0
            for (const key of this.mappingCache.keys()) {
                if (key.includes(pattern)) {
                    this.mappingCache.delete(key)
                    cleared++
                }
            }
            this.logger.debug({ cleared, pattern }, 'Cleared cache entries by pattern')
        }
    }

    getCacheStats() {
        return {
            size: this.mappingCache.size,
            hits: this.mappingCache.hits,
            misses: this.mappingCache.misses,
            hitRatio: this.mappingCache.hitRatio
        }
    }

    /**
     * Metodi helper privati
     */
    isValidLIDPNPair(lid, pn) {
        return (WABinary_1.isLidUser(lid) && WABinary_1.isJidUser(pn)) || 
               (WABinary_1.isJidUser(lid) && WABinary_1.isLidUser(pn))
    }

    extractUserParts(lid, pn) {
        const lidDecoded = WABinary_1.jidDecode(lid)
        const pnDecoded = WABinary_1.jidDecode(pn)
        
        return {
            lidUser: lidDecoded?.user,
            pnUser: pnDecoded?.user
        }
    }

    async getExistingMapping(pnUser, lidUser) {
        // Check cache first
        const cachedLid = this.mappingCache.get(`pn:${pnUser}`)
        if (cachedLid) {
            return { exists: true, matches: cachedLid === lidUser }
        }

        // Check database
        const stored = await this.keys.get('lid-mapping', [pnUser])
        const dbLid = stored[pnUser]
        
        return { 
            exists: !!dbLid, 
            matches: dbLid === lidUser 
        }
    }

    async getMappingFromDB(key) {
        try {
            const stored = await this.keys.get('lid-mapping', [key])
            return stored[key]
        } catch (error) {
            this.logger.error({ key, error }, 'Failed to get mapping from DB')
            return null
        }
    }

    async fetchLIDFromUSync(pn, pnUser) {
        // Evita richieste duplicate
        if (this.syncInProgress.has(pnUser)) {
            this.logger.trace({ pnUser }, 'USync request already in progress')
            await new Promise(resolve => setTimeout(resolve, 100))
            return this.mappingCache.get(`pn:${pnUser}`) || null
        }

        try {
            this.syncInProgress.add(pnUser)
            this.logger.trace({ pnUser }, 'Fetching LID from USync')

            const result = (await this.onWhatsAppFunc?.(pn))?.[0]
            
            if (result?.exists && result?.lid) {
                const lidUser = WABinary_1.jidDecode(result.lid)?.user
                if (lidUser) {
                    // Auto-store il mapping ottenuto
                    await this.storeLIDPNMappings([
                        { lid: result.lid, pn }
                    ], { skipCache: false })
                    
                    return lidUser
                }
            }
            
            return null
        } finally {
            this.syncInProgress.delete(pnUser)
        }
    }

    isValidUser(user) {
        return typeof user === 'string' && user.length > 0
    }
}

module.exports = {
    LIDMappingStore
}