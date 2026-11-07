import React, { useState, useMemo } from 'react'
import {
  TrendingUp,
  BarChart2,
  AlertTriangle,
  CheckCircle2,
  XCircle,
  Activity,
  Sparkles,
  Shield,
  Zap,
  Search,
  RefreshCw,
  Sliders,
  ChevronDown,
  ChevronUp,
  RotateCcw,
  X,
  Send,
  CreditCard,
  Flame,
  ChevronLeft,
  ChevronRight
} from 'lucide-react'

export const MarketAnalyticsModal = ({
  isOpen,
  onClose,
  data,
  isLoading,
  onRefresh,
  theme = 'dark',
  config,
  platform = 'bet9ja',
  dbName = '',
  baseCapital = 10000,
  onBaseCapitalChange,
  stakingMode = 'fixed',
  onStakingModeChange,
  stakingValue = 100,
  onStakingValueChange,
  pdfPlatform = 'current',
  setPdfPlatform,
  onSendPdf,
  sendingPdf = false,
  simDataSource = 'new_system',
  onSimDataSourceChange,
  onResetTrackingStats,
  resettingTracking = false,
  trackingResetMessage = ''
}) => {
  if (!isOpen) return null

  const isDark = theme !== 'light'
  const successColor = isDark ? '#10b981' : '#16a34a'
  const dangerColor = isDark ? '#ef4444' : '#dc2626'
  const warningColor = '#f59e0b'
  const accentColor = '#a855f7'

  // Navigation tab in modal: 'simulation' | 'markets' | 'ai_picks' | 'unified'
  const [activeTab, setActiveTab] = useState('simulation')

  // Statistics Source Selector
  const [localSimDataSource, setLocalSimDataSource] = useState('new_system')
  const activeDataSource = simDataSource ?? localSimDataSource
  const handleDataSourceChange = onSimDataSourceChange ?? setLocalSimDataSource

  // Market Radar Search & Sort
  const [marketSearchTerm, setMarketSearchTerm] = useState('')
  const [marketSortBy, setMarketSortBy] = useState('percentage') // 'percentage', 'total', 'market'

  // Simulation Filters
  const [simFilterStrategy, setSimFilterStrategy] = useState('all')
  const [simFilterMarket, setSimFilterMarket] = useState('all')
  const [simFilterMinOdds, setSimFilterMinOdds] = useState('')
  const [simFilterMaxOdds, setSimFilterMaxOdds] = useState('')
  const [simFilterMinProb, setSimFilterMinProb] = useState(0)
  const [simFilterTimeRange, setSimFilterTimeRange] = useState('all')
  const [simFilterOutcome, setSimFilterOutcome] = useState('all')
  const [simFilterTeam, setSimFilterTeam] = useState('')
  const [simFilterRoundMin, setSimFilterRoundMin] = useState('')
  const [simFilterRoundMax, setSimFilterRoundMax] = useState('')
  const [showAdvancedFilters, setShowAdvancedFilters] = useState(false)
  const [simShowEquityChart, setSimShowEquityChart] = useState(true)
  const [simShowBetLog, setSimShowBetLog] = useState(false)
  const [simBetLogPage, setSimBetLogPage] = useState(1)
  const [simBetLogSearch, setSimBetLogSearch] = useState('')

  // What-If Scenario Stress Testing
  const [whatIfEnabled, setWhatIfEnabled] = useState(false)
  const [whatIfExtraLosses, setWhatIfExtraLosses] = useState(3)
  const [whatIfRecoveryOdds, setWhatIfRecoveryOdds] = useState('2.0')
  const [whatIfPlacement, setWhatIfPlacement] = useState('worst_drawdown') // 'worst_drawdown', 'max_streak', 'end_of_replay'

  const resetFilters = () => {
    setSimFilterStrategy('all')
    setSimFilterMarket('all')
    setSimFilterMinOdds('')
    setSimFilterMaxOdds('')
    setSimFilterMinProb(0)
    setSimFilterTimeRange('all')
    setSimFilterOutcome('all')
    setSimFilterTeam('')
    setSimFilterRoundMin('')
    setSimFilterRoundMax('')
    setSimBetLogPage(1)
    setSimBetLogSearch('')
  }

  // Single Unified Data Source (Comprehensive settled bets across all strategies)
  const rawPicks = useMemo(() => {
    const paperPicks = (data?.paperTracking?.settledPicks || []).filter((p) => p.status === 'won' || p.status === 'lost' || p.status === 'void')
    const pubPicks = (data?.settledPicks || data?.publicationRows || []).filter((p) => p.status === 'won' || p.status === 'lost' || p.status === 'void')

    const pickMap = new Map()
    for (const p of paperPicks) {
      const rawType = (p.pick_type || p.engine || '').toLowerCase()
      const pType = ({ high_chance: 'high_value', ai_best: 'ai_best_pick' })[rawType] || rawType
      const key = `${p.season_name}_${p.round_number}_${pType}`
      pickMap.set(key, { ...p, pick_type: pType })
    }
    for (const p of pubPicks) {
      const rawType = (p.pick_type || p.engine || '').toLowerCase()
      const pType = ({ high_chance: 'high_value', ai_best: 'ai_best_pick' })[rawType] || rawType
      const key = `${p.season_name}_${p.round_number}_${pType}`
      if (!pickMap.has(key)) {
        pickMap.set(key, { ...p, pick_type: pType })
      }
    }
    return Array.from(pickMap.values()).sort((a, b) => (a.kickoff_timestamp || 0) - (b.kickoff_timestamp || 0))
  }, [data])

  const availableMarkets = useMemo(() => {
    return Array.from(new Set(rawPicks.map((p) => p.market).filter(Boolean))).sort()
  }, [rawPicks])

  // 1. Filtered Picks Calculation
  const filteredPicks = useMemo(() => {
    const now = Date.now()
    const startOfToday = new Date().setHours(0, 0, 0, 0)
    const endOfToday = new Date().setHours(23, 59, 59, 999)
    const startOfYesterday = startOfToday - 86400000
    const endOfYesterday = startOfToday - 1

    let list = rawPicks.filter((p) => {
      if (simFilterStrategy !== 'all') {
        const rawType = (p.pick_type || p.engine || '').toLowerCase()
        const pType = ({ high_chance: 'high_value', ai_best: 'ai_best_pick' })[rawType] || rawType
        if (pType !== simFilterStrategy) return false
      }

      if (simFilterMarket !== 'all') {
        if (simFilterMarket === 'goals_all') {
          const m = (p.market || '').toLowerCase()
          if (!m.includes('over') && !m.includes('under') && !m.includes('both teams') && !m.includes('gg')) {
            return false
          }
        } else if (p.market !== simFilterMarket) {
          return false
        }
      }

      const odd =
        p.sportybet_odd && p.sportybet_odd > 0
          ? p.sportybet_odd
          : p.implied_odd && p.implied_odd > 0
          ? p.implied_odd
          : 1.0
      if (simFilterMinOdds !== '' && !isNaN(Number(simFilterMinOdds)) && odd < Number(simFilterMinOdds)) {
        return false
      }
      if (simFilterMaxOdds !== '' && !isNaN(Number(simFilterMaxOdds)) && odd > Number(simFilterMaxOdds)) {
        return false
      }

      const prob = p.probability || 0
      if (simFilterMinProb > 0 && prob < simFilterMinProb) return false
      if (simFilterOutcome !== 'all' && p.status !== simFilterOutcome) return false

      if (simFilterTeam.trim()) {
        const term = simFilterTeam.trim().toLowerCase()
        const home = (p.home_team || '').toLowerCase()
        const away = (p.away_team || '').toLowerCase()
        if (!home.includes(term) && !away.includes(term)) return false
      }

      if (simFilterRoundMin !== '' && !isNaN(Number(simFilterRoundMin)) && p.round_number < Number(simFilterRoundMin)) {
        return false
      }
      if (simFilterRoundMax !== '' && !isNaN(Number(simFilterRoundMax)) && p.round_number > Number(simFilterRoundMax)) {
        return false
      }

      if (simFilterTimeRange !== 'all') {
        const rawTs = p.kickoff_timestamp ?? p.recorded_at ?? p.timestamp ?? (p.created_at ? new Date(p.created_at).getTime() : 0)
        const kickoff = Number(rawTs) > 0 && Number(rawTs) < 1e11 ? Number(rawTs) * 1000 : Number(rawTs) || 0

        if (simFilterTimeRange === 'today') {
          if (kickoff < startOfToday) return false
        } else if (simFilterTimeRange === 'yesterday') {
          if (kickoff < startOfYesterday || kickoff > endOfYesterday) return false
        } else if (simFilterTimeRange === 'last24h') {
          if (kickoff < now - 24 * 3600 * 1000) return false
        } else if (simFilterTimeRange === 'last3d') {
          if (kickoff < now - 3 * 86400 * 1000) return false
        } else if (simFilterTimeRange === 'last7d') {
          if (kickoff < now - 7 * 86400 * 1000) return false
        } else if (simFilterTimeRange === 'last30d') {
          if (kickoff < now - 30 * 86400 * 1000) return false
        }
      }

      return true
    })

    if (simFilterTimeRange === 'last100') list = list.slice(-100)
    else if (simFilterTimeRange === 'last250') list = list.slice(-250)
    else if (simFilterTimeRange === 'last500') list = list.slice(-500)

    return list
  }, [
    rawPicks,
    simFilterStrategy,
    simFilterMarket,
    simFilterMinOdds,
    simFilterMaxOdds,
    simFilterMinProb,
    simFilterOutcome,
    simFilterTeam,
    simFilterRoundMin,
    simFilterRoundMax,
    simFilterTimeRange
  ])

  // Count active non-default filters
  const activeFilterCount = useMemo(() => {
    let count = 0
    if (simFilterStrategy !== 'all') count++
    if (simFilterMarket !== 'all') count++
    if (simFilterMinOdds !== '' || simFilterMaxOdds !== '') count++
    if (simFilterMinProb > 0) count++
    if (simFilterTimeRange !== 'all') count++
    if (simFilterOutcome !== 'all') count++
    if (simFilterTeam.trim() !== '') count++
    if (simFilterRoundMin !== '' || simFilterRoundMax !== '') count++
    return count
  }, [
    simFilterStrategy,
    simFilterMarket,
    simFilterMinOdds,
    simFilterMaxOdds,
    simFilterMinProb,
    simFilterTimeRange,
    simFilterOutcome,
    simFilterTeam,
    simFilterRoundMin,
    simFilterRoundMax
  ])

  // 2. Real Chronological Simulation + Precise Minimum Capital Calculation
  const simResults = useMemo(() => {
    let currentBalance = baseCapital
    let peakBalance = baseCapital
    let maxDrawdownUnits = 0
    let maxDrawdownPct = 0
    let grossProfits = 0
    let grossLosses = 0
    let currentStreak = 0
    let maxWinStreak = 0
    let maxLossStreak = 0
    let totalStakedAmount = 0
    let maxSingleStake = 0
    let currentAccumulatedLoss = 0

    // Minimum Capital Calculation tracking:
    // Tracks net cash flow starting from zero. Before each round settles,
    // all simultaneous stakes must be committed upfront out-of-pocket.
    // The lowest pre-settlement trough determines the exact minimum starting capital.
    let netCumulativeFlow = 0
    let lowestCashTrough = 0
    let troughBetIdx = 0
    let troughRoundNumber = null
    let maxSimultaneousExposure = 0

    const equityPoints = [{ idx: 0, balance: baseCapital }]
    const betHistory = []

    const strategyStats = {
      overall: { played: 0, won: 0, lost: 0, void: 0, profit: 0, winRate: 0, roi: 0, balance: baseCapital, roc: 0, totalStaked: 0 },
      safest: { played: 0, won: 0, lost: 0, void: 0, profit: 0, winRate: 0, roi: 0, balance: baseCapital, roc: 0, totalStaked: 0 },
      high_value: { played: 0, won: 0, lost: 0, void: 0, profit: 0, winRate: 0, roi: 0, balance: baseCapital, roc: 0, totalStaked: 0 },
      ai_best_pick: { played: 0, won: 0, lost: 0, void: 0, profit: 0, winRate: 0, roi: 0, balance: baseCapital, roc: 0, totalStaked: 0 },
      goals: { played: 0, won: 0, lost: 0, void: 0, profit: 0, winRate: 0, roi: 0, balance: baseCapital, roc: 0, totalStaked: 0 },
      over35: { played: 0, won: 0, lost: 0, void: 0, profit: 0, winRate: 0, roi: 0, balance: baseCapital, roc: 0, totalStaked: 0 },
      under35: { played: 0, won: 0, lost: 0, void: 0, profit: 0, winRate: 0, roi: 0, balance: baseCapital, roc: 0, totalStaked: 0 },
      market_specialist: { played: 0, won: 0, lost: 0, void: 0, profit: 0, winRate: 0, roi: 0, balance: baseCapital, roc: 0, totalStaked: 0 }
    }

    // Process bets and group concurrent rounds
    let i = 0
    while (i < filteredPicks.length) {
      // Find all bets that share the same kickoff or round (simultaneous round execution)
      const currentRound = filteredPicks[i].round_number
      const currentKickoff = filteredPicks[i].kickoff_timestamp
      const roundBets = []

      while (
        i < filteredPicks.length &&
        ((currentRound != null && filteredPicks[i].round_number === currentRound) ||
          (currentKickoff != null && filteredPicks[i].kickoff_timestamp === currentKickoff) ||
          roundBets.length === 0)
      ) {
        roundBets.push(filteredPicks[i])
        i++
      }

      let totalRoundStakes = 0
      const roundCalculated = []

      // Step A: Calculate stakes for all concurrent bets in this round
      for (const p of roundBets) {
        const rawType = (p.pick_type || p.engine || 'ai_best_pick').toLowerCase()
        const type = ({ high_chance: 'high_value', ai_best: 'ai_best_pick' })[rawType] || rawType
        const odd =
          p.sportybet_odd && p.sportybet_odd > 0
            ? p.sportybet_odd
            : p.implied_odd && p.implied_odd > 0
            ? p.implied_odd
            : 1.0
        const probDecimal = (p.probability || 50) / 100

        let betStake = 100
        if (stakingMode === 'fixed') {
          betStake = stakingValue
        } else if (stakingMode === 'percent') {
          betStake = (stakingValue / 100) * baseCapital
        } else if (stakingMode === 'compounding') {
          betStake = Math.max(1, (stakingValue / 100) * currentBalance)
        } else if (stakingMode.startsWith('martingale')) {
          const mult = stakingMode === 'martingale_1_5' ? 1.5 : stakingMode === 'martingale_3_0' ? 3.0 : 2.0
          const lossCount = currentStreak < 0 ? Math.abs(currentStreak) : 0
          if (stakingMode === 'martingale_2_0' && lossCount > 0 && odd < 2.0) {
            // Option 1: Odds-adjusted dynamic recovery Martingale
            const accLoss = currentAccumulatedLoss > 0 ? currentAccumulatedLoss : stakingValue * (Math.pow(2, lossCount) - 1)
            const targetProfit = stakingValue
            betStake = Math.max(stakingValue, (accLoss + targetProfit) / (odd - 1))
          } else {
            const rawMult = Math.pow(mult, lossCount)
            betStake = Math.max(1, stakingValue * (Number.isFinite(rawMult) ? rawMult : 1e12))
          }
        } else if (stakingMode === 'kelly_half' || stakingMode === 'kelly_quarter') {
          const b = Math.max(0.01, odd - 1)
          const q = 1 - probDecimal
          const fullKelly = (b * probDecimal - q) / b
          const multiplier = stakingMode === 'kelly_half' ? 0.5 : 0.25
          const safeKellyFraction = Math.max(0.005, Math.min(0.2, fullKelly * multiplier))
          betStake = Math.max(1, currentBalance * safeKellyFraction)
        }
        betStake = parseFloat(betStake.toFixed(1))
        if (betStake > maxSingleStake) maxSingleStake = betStake

        if (p.status !== 'void') {
          totalRoundStakes += betStake
        }
        roundCalculated.push({ p, type, odd, betStake })
      }

      if (totalRoundStakes > maxSimultaneousExposure) {
        maxSimultaneousExposure = totalRoundStakes
      }

      // Pre-settlement trough check: Cash must be on hand BEFORE round finishes
      const preSettlementFlow = netCumulativeFlow - totalRoundStakes
      if (preSettlementFlow < lowestCashTrough) {
        lowestCashTrough = preSettlementFlow
        troughBetIdx = betHistory.length + 1
        troughRoundNumber = currentRound
      }

      // Step B: Settle bets and update balance, profits, and streaks
      for (const item of roundCalculated) {
        const { p, type, odd, betStake } = item
        if (p.status !== 'won' && p.status !== 'lost' && p.status !== 'void') continue
        let betProfit = 0

        if (p.status === 'void') {
          if (strategyStats[type]) strategyStats[type].void++
          strategyStats.overall.void++
        } else {
          totalStakedAmount += betStake
          if (strategyStats[type]) {
            strategyStats[type].played++
            strategyStats[type].totalStaked += betStake
          }
          strategyStats.overall.played++
          strategyStats.overall.totalStaked += betStake

          if (p.status === 'won') {
            betProfit = (odd - 1.0) * betStake
            grossProfits += betProfit
            currentBalance += betProfit
            netCumulativeFlow += betProfit

            if (currentStreak > 0) currentStreak++
            else currentStreak = 1
            if (currentStreak > maxWinStreak) maxWinStreak = currentStreak
            currentAccumulatedLoss = 0

            if (strategyStats[type]) {
              strategyStats[type].won++
              strategyStats[type].profit += betProfit
            }
            strategyStats.overall.won++
            strategyStats.overall.profit += betProfit
          } else if (p.status === 'lost') {
            betProfit = -betStake
            grossLosses += betStake
            currentBalance -= betStake
            netCumulativeFlow -= betStake
            currentAccumulatedLoss += betStake

            if (currentStreak < 0) currentStreak--
            else currentStreak = -1
            if (Math.abs(currentStreak) > maxLossStreak) maxLossStreak = Math.abs(currentStreak)

            if (strategyStats[type]) {
              strategyStats[type].lost++
              strategyStats[type].profit += betProfit
            }
            strategyStats.overall.lost++
            strategyStats.overall.profit += betProfit
          }

          // Peak and Drawdown tracking
          if (currentBalance > peakBalance) {
            peakBalance = currentBalance
          }
          const ddUnits = peakBalance - currentBalance
          if (ddUnits > maxDrawdownUnits) maxDrawdownUnits = ddUnits
          const ddPct = peakBalance > 0 ? (ddUnits / peakBalance) * 100 : 0
          if (ddPct > maxDrawdownPct) maxDrawdownPct = ddPct
        }

        currentBalance = parseFloat(currentBalance.toFixed(1))
        equityPoints.push({ idx: betHistory.length + 1, balance: currentBalance })
        betHistory.push({
          ...p,
          betIdx: betHistory.length + 1,
          stake: betStake,
          odd,
          profit: parseFloat(betProfit.toFixed(1)),
          balanceAfter: currentBalance
        })
      }
    }

    // Minimum Capital Required to survive this replay without balance ever dropping below 0:
    const minCapitalNeeded = Math.max(0, Math.ceil(-lowestCashTrough))
    const recommendedCapital = Math.ceil(minCapitalNeeded * 1.25)
    const isCapitalFunded = baseCapital >= minCapitalNeeded

    // Strategy summaries
    for (const key of Object.keys(strategyStats)) {
      const s = strategyStats[key]
      s.winRate = s.played > 0 ? parseFloat(((s.won / s.played) * 100).toFixed(1)) : 0
      s.roi = s.totalStaked > 0 ? parseFloat(((s.profit / s.totalStaked) * 100).toFixed(1)) : 0
      s.profit = parseFloat(s.profit.toFixed(1))
      s.balance = parseFloat((baseCapital + s.profit).toFixed(1))
      s.roc = baseCapital > 0 ? parseFloat(((s.profit / baseCapital) * 100).toFixed(1)) : 0
    }

    const netProfit = currentBalance - baseCapital
    const profitFactor =
      grossLosses > 0 ? (grossProfits / grossLosses).toFixed(2) : grossProfits > 0 ? '∞' : '0.00'
    const overallRoi =
      totalStakedAmount > 0 ? parseFloat(((netProfit / totalStakedAmount) * 100).toFixed(2)) : 0
    const overallRoc = baseCapital > 0 ? parseFloat(((netProfit / baseCapital) * 100).toFixed(2)) : 0
    const avgStake =
      strategyStats.overall.played > 0
        ? parseFloat((totalStakedAmount / strategyStats.overall.played).toFixed(1))
        : 0

    return {
      currentBalance,
      peakBalance,
      netProfit,
      maxDrawdownUnits,
      maxDrawdownPct,
      maxWinStreak,
      maxLossStreak,
      totalStakedAmount,
      profitFactor,
      overallRoi,
      overallRoc,
      avgStake,
      maxSingleStake,
      maxSimultaneousExposure,
      minCapitalNeeded,
      recommendedCapital,
      isCapitalFunded,
      troughBetIdx,
      troughRoundNumber,
      lowestCashTrough,
      strategyStats,
      equityPoints,
      betHistory
    }
  }, [filteredPicks, baseCapital, stakingMode, stakingValue])

  // 3. What-If Scenario Stress Test Simulation Execution
  const whatIfResults = useMemo(() => {
    if (!whatIfEnabled) return null

    const extraLosses = Math.max(1, Number(whatIfExtraLosses) || 3)
    const recoveryOdd = Math.max(1.05, Number(whatIfRecoveryOdds) || 2.0)
    
    // Build stress bets sequence
    const stressPicks = [...filteredPicks]
    const syntheticLosses = Array.from({ length: extraLosses }, (_, idx) => ({
      id: `synthetic-loss-${idx + 1}`,
      season_name: 'Stress Test',
      round_number: 999,
      home_team: `Stress Loss #${idx + 1}`,
      away_team: 'Simulated Hazard',
      market: 'Over 2.5',
      pick_type: 'ai_best_pick',
      probability: 45,
      implied_odd: 2.1,
      sportybet_odd: 2.1,
      status: 'lost',
      isSynthetic: true
    }))

    const syntheticRecoveryWin = {
      id: 'synthetic-recovery-win',
      season_name: 'Stress Test',
      round_number: 1000,
      home_team: 'Recovery Break',
      away_team: 'Stress Rebound',
      market: 'Home Win',
      pick_type: 'ai_best_pick',
      probability: 50,
      implied_odd: recoveryOdd,
      sportybet_odd: recoveryOdd,
      status: 'won',
      isSynthetic: true
    }

    let injectionIndex = stressPicks.length
    if (whatIfPlacement === 'worst_drawdown' && simResults.troughBetIdx > 0) {
      injectionIndex = Math.min(stressPicks.length, simResults.troughBetIdx)
    } else if (whatIfPlacement === 'max_streak') {
      // Find where maximum loss streak occurred
      let currL = 0
      let maxL = 0
      let bestIdx = stressPicks.length
      for (let k = 0; k < stressPicks.length; k++) {
        if (stressPicks[k].status === 'lost') {
          currL++
          if (currL > maxL) {
            maxL = currL
            bestIdx = k + 1
          }
        } else {
          currL = 0
        }
      }
      injectionIndex = bestIdx
    }

    stressPicks.splice(injectionIndex, 0, ...syntheticLosses, syntheticRecoveryWin)

    // Run parallel simulation on stressPicks
    let sBalance = baseCapital
    let sPeak = baseCapital
    let sMaxDrawdownUnits = 0
    let sMaxDrawdownPct = 0
    let sCurrentStreak = 0
    let sMaxLossStreak = 0
    let sGrossProfits = 0
    let sGrossLosses = 0
    let sTotalStaked = 0
    let sMaxSingleStake = 0
    let sCurrentAccumulatedLoss = 0
    let sNetFlow = 0
    let sLowestCashTrough = 0

    const sEquityPoints = [{ idx: 0, balance: baseCapital }]

    for (let k = 0; k < stressPicks.length; k++) {
      const p = stressPicks[k]
      const odd = p.implied_odd || 2.0
      const probDecimal = (p.probability || 50) / 100

      let betStake = 100
      if (stakingMode === 'fixed') {
        betStake = stakingValue
      } else if (stakingMode === 'percent') {
        betStake = (stakingValue / 100) * baseCapital
      } else if (stakingMode === 'compounding') {
        betStake = Math.max(1, (stakingValue / 100) * sBalance)
      } else if (stakingMode.startsWith('martingale')) {
        const mult = stakingMode === 'martingale_1_5' ? 1.5 : stakingMode === 'martingale_3_0' ? 3.0 : 2.0
        const lossCount = sCurrentStreak < 0 ? Math.abs(sCurrentStreak) : 0
        if (stakingMode === 'martingale_2_0' && lossCount > 0 && odd < 2.0) {
          const accLoss = sCurrentAccumulatedLoss > 0 ? sCurrentAccumulatedLoss : stakingValue * (Math.pow(2, lossCount) - 1)
          const targetProfit = stakingValue
          betStake = Math.max(stakingValue, (accLoss + targetProfit) / (odd - 1))
        } else {
          const rawMult = Math.pow(mult, lossCount)
          betStake = Math.max(1, stakingValue * (Number.isFinite(rawMult) ? rawMult : 1e12))
        }
      } else if (stakingMode === 'kelly_half' || stakingMode === 'kelly_quarter') {
        const b = Math.max(0.01, odd - 1)
        const q = 1 - probDecimal
        const fullKelly = (b * probDecimal - q) / b
        const multiplier = stakingMode === 'kelly_half' ? 0.5 : 0.25
        const safeKellyFraction = Math.max(0.005, Math.min(0.2, fullKelly * multiplier))
        betStake = Math.max(1, sBalance * safeKellyFraction)
      }
      betStake = parseFloat(betStake.toFixed(1))
      if (betStake > sMaxSingleStake) sMaxSingleStake = betStake

      const preFlow = sNetFlow - betStake
      if (preFlow < sLowestCashTrough) {
        sLowestCashTrough = preFlow
      }

      if (p.status !== 'void') {
        sTotalStaked += betStake
        if (p.status === 'won') {
          const profit = (odd - 1.0) * betStake
          sGrossProfits += profit
          sBalance += profit
          sNetFlow += profit
          if (sCurrentStreak > 0) sCurrentStreak++
          else sCurrentStreak = 1
          sCurrentAccumulatedLoss = 0
        } else if (p.status === 'lost') {
          sGrossLosses += betStake
          sBalance -= betStake
          sNetFlow -= betStake
          sCurrentAccumulatedLoss += betStake
          if (sCurrentStreak < 0) sCurrentStreak--
          else sCurrentStreak = -1
          if (Math.abs(sCurrentStreak) > sMaxLossStreak) sMaxLossStreak = Math.abs(sCurrentStreak)
        }

        if (sBalance > sPeak) sPeak = sBalance
        const dd = sPeak - sBalance
        if (dd > sMaxDrawdownUnits) sMaxDrawdownUnits = dd
        const ddPct = sPeak > 0 ? (dd / sPeak) * 100 : 0
        if (ddPct > sMaxDrawdownPct) sMaxDrawdownPct = ddPct
      }

      sBalance = parseFloat(sBalance.toFixed(1))
      sEquityPoints.push({ idx: k + 1, balance: sBalance })
    }

    const sNetProfit = sBalance - baseCapital
    const sMinCapitalNeeded = Math.max(0, Math.ceil(-sLowestCashTrough))
    const sRecommendedCapital = Math.ceil(sMinCapitalNeeded * 1.25)
    const isAbsorbed = baseCapital >= sMinCapitalNeeded

    // Risk tier evaluation
    let riskTier = 'LOW'
    let riskLabel = 'Low Risk — Bankroll Absorbs Stress'
    let riskBadgeColor = successColor
    if (sMinCapitalNeeded > baseCapital * 2 || sBalance <= 0) {
      riskTier = 'CRITICAL'
      riskLabel = 'Critical Hazard — Bankroll Depletion Risk'
      riskBadgeColor = dangerColor
    } else if (sMinCapitalNeeded > baseCapital) {
      riskTier = 'HIGH'
      riskLabel = 'High Vulnerability — Requires Additional Capital'
      riskBadgeColor = '#f97316'
    } else if (sMinCapitalNeeded > baseCapital * 0.75) {
      riskTier = 'MODERATE'
      riskLabel = 'Moderate Exposure — Reduced Margin Buffer'
      riskBadgeColor = warningColor
    }

    return {
      extraLosses,
      recoveryOdd,
      effectiveCap,
      sBalance,
      sNetProfit,
      sMaxDrawdownUnits,
      sMaxDrawdownPct,
      sMaxLossStreak,
      sMaxSingleStake,
      sMinCapitalNeeded,
      sRecommendedCapital,
      isAbsorbed,
      riskTier,
      riskLabel,
      riskBadgeColor,
      sEquityPoints,
      stressPicksCount: stressPicks.length
    }
  }, [
    whatIfEnabled,
    whatIfExtraLosses,
    whatIfRecoveryOdds,
        whatIfPlacement,
    filteredPicks,
    simResults,
    baseCapital,
    stakingMode,
    stakingValue,
    successColor,
    dangerColor,
    warningColor
  ])

  // 4. Responsive SVG Equity Curve Generator
  const { svgPointsStr, stressSvgPointsStr, baselineY, svgW, svgH, svgPad } = useMemo(() => {
    const pts = simResults.equityPoints
    const sPts = whatIfResults ? whatIfResults.sEquityPoints : null

    const svgW = 750
    const svgH = 130
    const svgPad = 14

    // Downsample for crisp rendering
    const step = Math.max(1, Math.floor(pts.length / 140))
    const sampled = pts.filter((_, i) => i % step === 0 || i === pts.length - 1)

    let allBalances = sampled.map((p) => p.balance)
    let sSampled = []
    if (sPts && sPts.length > 0) {
      const sStep = Math.max(1, Math.floor(sPts.length / 140))
      sSampled = sPts.filter((_, i) => i % sStep === 0 || i === sPts.length - 1)
      allBalances = allBalances.concat(sSampled.map((p) => p.balance))
    }

    const minB = Math.min(...allBalances, baseCapital)
    const maxB = Math.max(...allBalances, baseCapital)
    const bRange = Math.max(1, maxB - minB)

    const pointsStr = sampled
      .map((pt, index) => {
        const x = svgPad + (index / Math.max(1, sampled.length - 1)) * (svgW - svgPad * 2)
        const y = svgH - svgPad - ((pt.balance - minB) / bRange) * (svgH - svgPad * 2)
        return `${x.toFixed(1)},${y.toFixed(1)}`
      })
      .join(' ')

    let stressStr = ''
    if (sSampled.length > 0) {
      stressStr = sSampled
        .map((pt, index) => {
          const x = svgPad + (index / Math.max(1, sSampled.length - 1)) * (svgW - svgPad * 2)
          const y = svgH - svgPad - ((pt.balance - minB) / bRange) * (svgH - svgPad * 2)
          return `${x.toFixed(1)},${y.toFixed(1)}`
        })
        .join(' ')
    }

    const baselineY = svgH - svgPad - ((baseCapital - minB) / bRange) * (svgH - svgPad * 2)

    return {
      svgPointsStr: pointsStr,
      stressSvgPointsStr: stressStr,
      baselineY,
      svgW,
      svgH,
      svgPad
    }
  }, [simResults.equityPoints, whatIfResults, baseCapital])

  // 5. Market Radar Filter & Sort
  const marketRadarList = useMemo(() => {
    if (!data?.markets) return []
    let list = Object.entries(data.markets).map(([market, stats]) => ({
      market,
      ...stats
    }))

    if (marketSearchTerm.trim()) {
      const q = marketSearchTerm.toLowerCase()
      list = list.filter((m) => m.market.toLowerCase().includes(q))
    }

    list.sort((a, b) => {
      if (marketSortBy === 'percentage') return (b.percentage || 0) - (a.percentage || 0)
      if (marketSortBy === 'total') return (b.total || 0) - (a.total || 0)
      return a.market.localeCompare(b.market)
    })

    return list
  }, [data?.markets, marketSearchTerm, marketSortBy])

  // 6. Detailed Bet Log Search & Pagination
  const searchedBets = useMemo(() => {
    if (!simBetLogSearch.trim()) return simResults.betHistory
    const q = simBetLogSearch.toLowerCase()
    return simResults.betHistory.filter((b) => {
      const match = `${b.home_team || ''} vs ${b.away_team || ''}`.toLowerCase()
      const mkt = (b.market || '').toLowerCase()
      const rnd = String(b.round_number || '')
      return match.includes(q) || mkt.includes(q) || rnd.includes(q)
    })
  }, [simResults.betHistory, simBetLogSearch])

  const pageSize = 25
  const totalPages = Math.max(1, Math.ceil(searchedBets.length / pageSize))
  const currentPage = Math.min(Math.max(1, simBetLogPage), totalPages)
  const pagedBets = useMemo(() => {
    const start = (currentPage - 1) * pageSize
    return searchedBets.slice(start, start + pageSize)
  }, [searchedBets, currentPage])

  // Preset & Filter Helpers
  const isStrategyActive = (id) => {
    if (id === 'all') {
      return simFilterStrategy === 'all' && simFilterMarket === 'all' && simFilterMinOdds === ''
    }
    if (id === 'safest') return simFilterStrategy === 'safest'
    if (id === 'high_value') return simFilterStrategy === 'high_value'
    if (id === 'ai_best_pick') return simFilterStrategy === 'ai_best_pick'
    if (id === 'goals_engine') return simFilterStrategy === 'goals'
    if (id === 'goals_market') return simFilterMarket === 'goals_all'
    if (id === 'high_odds') return simFilterMinOdds === '3.0'
    return false
  }

  const handleStrategyPreset = (id) => {
    if (id === 'all') {
      setSimFilterStrategy('all')
      setSimFilterMarket('all')
      setSimFilterMinOdds('')
    } else if (id === 'safest') {
      setSimFilterStrategy(simFilterStrategy === 'safest' ? 'all' : 'safest')
    } else if (id === 'high_value') {
      setSimFilterStrategy(simFilterStrategy === 'high_value' ? 'all' : 'high_value')
    } else if (id === 'ai_best_pick') {
      setSimFilterStrategy(simFilterStrategy === 'ai_best_pick' ? 'all' : 'ai_best_pick')
    } else if (id === 'goals_engine') {
      setSimFilterStrategy(simFilterStrategy === 'goals' ? 'all' : 'goals')
    } else if (id === 'goals_market') {
      setSimFilterMarket(simFilterMarket === 'goals_all' ? 'all' : 'goals_all')
    } else if (id === 'high_odds') {
      setSimFilterMinOdds(simFilterMinOdds === '3.0' ? '' : '3.0')
    }
  }

  const handleTimePreset = (range) => {
    setSimFilterTimeRange(simFilterTimeRange === range ? 'all' : range)
  }

  const timeRangeLabels = {
    all: 'All Time',
    today: 'Today',
    yesterday: 'Yesterday',
    last24h: 'Last 24h',
    last3d: 'Last 3 Days',
    last7d: 'Last 7 Days',
    last30d: 'Last 30 Days',
    last100: 'Last 100 Bets',
    last250: 'Last 250 Bets',
    last500: 'Last 500 Bets'
  }

  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        background: 'rgba(0, 0, 0, 0.75)',
        backdropFilter: 'blur(8px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: 10000,
        padding: '1rem'
      }}
    >
      <div
        style={{
          background: isDark ? 'linear-gradient(145deg, #0d1117, #161b22)' : '#ffffff',
          borderRadius: '16px',
          maxWidth: '1360px',
          width: '96%',
          maxHeight: '92vh',
          display: 'flex',
          flexDirection: 'column',
          border: isDark ? '1px solid rgba(255, 255, 255, 0.1)' : '1px solid #e2e8f0',
          boxShadow: isDark
            ? '0 25px 70px rgba(0, 0, 0, 0.8), 0 0 1px 1px rgba(168, 85, 247, 0.2)'
            : '0 25px 70px rgba(0, 0, 0, 0.15)',
          overflow: 'hidden',
          color: isDark ? '#f3f4f6' : '#1f2937'
        }}
      >
        {/* ── TOP HEADER ── */}
        <div
          style={{
            padding: '1rem 1.5rem',
            borderBottom: isDark ? '1px solid rgba(255, 255, 255, 0.08)' : '1px solid #e5e7eb',
            background: isDark ? 'rgba(255, 255, 255, 0.02)' : '#f9fafb',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            flexWrap: 'wrap',
            gap: '1rem'
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
            <div
              style={{
                width: '42px',
                height: '42px',
                borderRadius: '12px',
                background: 'linear-gradient(135deg, rgba(168,85,247,0.25), rgba(59,130,246,0.25))',
                border: '1px solid rgba(168,85,247,0.4)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center'
              }}
            >
              <TrendingUp size={22} color="#c084fc" />
            </div>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <h2 style={{ margin: 0, fontSize: '1.25rem', fontWeight: 800, letterSpacing: '-0.02em' }}>
                  Market Analytics & Staking Lab
                </h2>
                <span
                  style={{
                    fontSize: '0.68rem',
                    fontWeight: 700,
                    padding: '0.15rem 0.55rem',
                    borderRadius: '20px',
                    background: platform === 'sportybet' ? 'rgba(239, 68, 68, 0.15)' : 'rgba(34, 197, 94, 0.15)',
                    color: platform === 'sportybet' ? '#f87171' : '#4ade80',
                    border: `1px solid ${platform === 'sportybet' ? 'rgba(239,68,68,0.3)' : 'rgba(34,197,94,0.3)'}`
                  }}
                >
                  {platform.toUpperCase()}
                </span>
                {dbName && (
                  <span
                    style={{
                      fontSize: '0.68rem',
                      color: 'var(--text-secondary, #94a3b8)',
                      background: 'rgba(255,255,255,0.05)',
                      padding: '0.15rem 0.5rem',
                      borderRadius: '6px'
                    }}
                  >
                    {dbName}
                  </span>
                )}
              </div>
              <div style={{ fontSize: '0.74rem', color: isDark ? '#94a3b8' : '#64748b', marginTop: '0.15rem' }}>
                Historical Replay • Risk Stress Testing • Minimum Capital Allocation Engine
              </div>
            </div>
          </div>

          {/* Tab Navigation Pill Bar */}
          <div
            style={{
              display: 'flex',
              background: isDark ? 'rgba(0, 0, 0, 0.35)' : '#e2e8f0',
              padding: '0.25rem',
              borderRadius: '10px',
              border: isDark ? '1px solid rgba(255, 255, 255, 0.08)' : '1px solid #cbd5e1',
              gap: '0.25rem'
            }}
          >
            {[
              { id: 'simulation', label: '📊 Staking & Bankroll Replay' },
              { id: 'markets', label: `🎯 Market Radar (${marketRadarList.length})` },
              { id: 'ai_picks', label: '⚡ AI Predictions' },
              { id: 'unified', label: '🌐 Unified View' }
            ].map((tab) => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id)}
                style={{
                  padding: '0.35rem 0.85rem',
                  borderRadius: '7px',
                  border: 'none',
                  fontSize: '0.78rem',
                  fontWeight: 700,
                  cursor: 'pointer',
                  transition: 'all 0.15s ease',
                  background: activeTab === tab.id ? 'linear-gradient(135deg, #a855f7 0%, #6366f1 100%)' : 'transparent',
                  color: activeTab === tab.id ? '#ffffff' : isDark ? '#94a3b8' : '#475569',
                  boxShadow: activeTab === tab.id ? '0 2px 8px rgba(168, 85, 247, 0.35)' : 'none'
                }}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* Actions & Close */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
            <button
              onClick={onRefresh}
              disabled={isLoading}
              title="Refresh Market Analytics"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '0.35rem',
                padding: '0.4rem 0.8rem',
                borderRadius: '8px',
                background: isDark ? 'rgba(255, 255, 255, 0.05)' : '#f1f5f9',
                border: isDark ? '1px solid rgba(255, 255, 255, 0.1)' : '1px solid #cbd5e1',
                color: isDark ? '#e2e8f0' : '#334155',
                fontSize: '0.78rem',
                fontWeight: 600,
                cursor: 'pointer'
              }}
            >
              <RefreshCw size={13} style={{ animation: isLoading ? 'spin 1s linear infinite' : 'none' }} />
              Refresh
            </button>
            <button
              onClick={onClose}
              style={{
                width: '34px',
                height: '34px',
                borderRadius: '8px',
                background: isDark ? 'rgba(239, 68, 68, 0.12)' : '#fee2e2',
                border: isDark ? '1px solid rgba(239, 68, 68, 0.3)' : '1px solid #fca5a5',
                color: '#ef4444',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                transition: 'all 0.15s'
              }}
            >
              <X size={18} />
            </button>
          </div>
        </div>

        {/* ── MODAL BODY CONTENT ── */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '1.25rem 1.5rem' }}>
          {isLoading ? (
            <div style={{ textAlign: 'center', padding: '4rem 1rem', color: isDark ? '#94a3b8' : '#64748b' }}>
              <RefreshCw size={42} style={{ animation: 'spin 1s linear infinite', margin: '0 auto 1rem', color: accentColor }} />
              <p style={{ fontSize: '1rem', fontWeight: 600 }}>Loading comprehensive market statistics & replay logs...</p>
            </div>
          ) : !data || Object.keys(data.markets || {}).length === 0 ? (
            <div style={{ textAlign: 'center', padding: '4rem 1rem', color: isDark ? '#94a3b8' : '#64748b' }}>
              <AlertTriangle size={42} color={warningColor} style={{ margin: '0 auto 1rem' }} />
              <p style={{ fontSize: '1.05rem', fontWeight: 700 }}>No settled market history found in this database.</p>
              <p style={{ fontSize: '0.85rem', opacity: 0.8 }}>Run the bot or sync historical archives to see analytics.</p>
            </div>
          ) : (
            <div>
              {/* ══════════════════════════════════════════════════════════════════
                  VIEW 1: STAKING & BANKROLL SIMULATION + WHAT-IF LAB
                  ══════════════════════════════════════════════════════════════════ */}
              {(activeTab === 'simulation' || activeTab === 'unified') && (
                <div style={{ marginBottom: activeTab === 'unified' ? '2.5rem' : '0' }}>
                  {/* CONTROL DECK & STAKING BAR */}
                  <div
                    style={{
                      background: isDark ? 'rgba(255, 255, 255, 0.025)' : '#f8fafc',
                      border: isDark ? '1px solid rgba(255, 255, 255, 0.08)' : '1px solid #e2e8f0',
                      borderRadius: '12px',
                      padding: '1rem',
                      marginBottom: '1rem'
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        flexWrap: 'wrap',
                        gap: '0.75rem',
                        marginBottom: '0.75rem'
                      }}
                    >
                      {/* Left: Staking Engine Controls */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
                        <div>
                          <label style={{ fontSize: '0.7rem', color: isDark ? '#94a3b8' : '#64748b', display: 'block', fontWeight: 700, marginBottom: '0.2rem' }}>
                            STAKING ENGINE
                          </label>
                          <select
                            value={stakingMode}
                            onChange={(e) => onStakingModeChange && onStakingModeChange(e.target.value)}
                            style={{
                              padding: '0.35rem 0.65rem',
                              borderRadius: '7px',
                              background: isDark ? '#0f172a' : '#ffffff',
                              border: isDark ? '1px solid rgba(255, 255, 255, 0.15)' : '1px solid #cbd5e1',
                              color: isDark ? '#f8fafc' : '#0f172a',
                              fontSize: '0.8rem',
                              fontWeight: 700,
                              outline: 'none'
                            }}
                          >
                            <option value="fixed">Fixed Stake</option>
                            <option value="percent">Percentage of Base Capital</option>
                            <option value="compounding">Dynamic Compounding (% of Balance)</option>
                            <option value="martingale_1_5">Martingale 1.5x Multiplier</option>
                            <option value="martingale_2_0">Martingale 2.0x (Odds-Adjusted Recovery)</option>
                            <option value="martingale_3_0">Martingale 3.0x Aggressive</option>
                            <option value="kelly_half">Kelly Half-Size (Conservative)</option>
                            <option value="kelly_quarter">Kelly Quarter-Size (Ultra Safe)</option>
                          </select>
                        </div>

                        {stakingMode.startsWith('martingale') && (
                          <div>
                            <label style={{ fontSize: '0.7rem', color: isDark ? '#94a3b8' : '#64748b', display: 'block', fontWeight: 700, marginBottom: '0.2rem' }}>
                              STAKING SCALING
                            </label>
                            <div
                              style={{
                                padding: '0.35rem 0.65rem',
                                borderRadius: '7px',
                                background: 'rgba(239, 68, 68, 0.12)',
                                border: '1px solid rgba(239, 68, 68, 0.3)',
                                color: '#f87171',
                                fontSize: '0.78rem',
                                fontWeight: 800,
                                whiteSpace: 'nowrap',
                                display: 'flex',
                                alignItems: 'center',
                                gap: '0.35rem'
                              }}
                            >
                              <span>⚡ Unlimited / Uncapped</span>
                            </div>
                          </div>
                        )}

                        <div>
                          <label style={{ fontSize: '0.7rem', color: isDark ? '#94a3b8' : '#64748b', display: 'block', fontWeight: 700, marginBottom: '0.2rem' }}>
                            STARTING BANKROLL (u)
                          </label>
                          <input
                            type="number"
                            step="1000"
                            value={baseCapital}
                            onChange={(e) => onBaseCapitalChange && onBaseCapitalChange(Math.max(10, Number(e.target.value) || 0))}
                            style={{
                              width: '110px',
                              padding: '0.35rem 0.5rem',
                              borderRadius: '7px',
                              background: isDark ? '#0f172a' : '#ffffff',
                              border: isDark ? '1px solid rgba(255, 255, 255, 0.15)' : '1px solid #cbd5e1',
                              color: isDark ? '#f8fafc' : '#0f172a',
                              fontSize: '0.8rem',
                              fontWeight: 700,
                              textAlign: 'right'
                            }}
                          />
                        </div>

                        <div>
                          <label style={{ fontSize: '0.7rem', color: isDark ? '#94a3b8' : '#64748b', display: 'block', fontWeight: 700, marginBottom: '0.2rem' }}>
                            {stakingMode.startsWith('kelly') ? 'KELLY BASE FRACTION' : stakingMode.startsWith('martingale') || stakingMode === 'fixed' ? 'BASE STAKE (u)' : 'BET SIZE (%)'}
                          </label>
                          <input
                            type="number"
                            step={stakingMode === 'fixed' || stakingMode.startsWith('martingale') ? '10' : '0.5'}
                            value={stakingValue}
                            onChange={(e) => onStakingValueChange && onStakingValueChange(Math.max(0.01, Number(e.target.value) || 0.01))}
                            style={{
                              width: '85px',
                              padding: '0.35rem 0.5rem',
                              borderRadius: '7px',
                              background: isDark ? '#0f172a' : '#ffffff',
                              border: isDark ? '1px solid rgba(255, 255, 255, 0.15)' : '1px solid #cbd5e1',
                              color: isDark ? '#f8fafc' : '#0f172a',
                              fontSize: '0.8rem',
                              fontWeight: 700,
                              textAlign: 'right'
                            }}
                          />
                        </div>
                      </div>

                      {/* Right: Quick Action What-If Toggle & Telegram Export */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                        <button
                          onClick={() => setWhatIfEnabled(!whatIfEnabled)}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '0.4rem',
                            padding: '0.4rem 0.85rem',
                            borderRadius: '8px',
                            cursor: 'pointer',
                            border: whatIfEnabled ? '1.5px solid #f59e0b' : isDark ? '1px solid rgba(255,255,255,0.15)' : '1px solid #cbd5e1',
                            background: whatIfEnabled ? 'rgba(245, 158, 11, 0.15)' : isDark ? 'rgba(255,255,255,0.05)' : '#ffffff',
                            color: whatIfEnabled ? '#fbbf24' : isDark ? '#e2e8f0' : '#475569',
                            fontWeight: 700,
                            fontSize: '0.78rem',
                            transition: 'all 0.15s'
                          }}
                        >
                          <Zap size={14} color={whatIfEnabled ? '#fbbf24' : '#94a3b8'} />
                          {whatIfEnabled ? 'What-If Stress: ON' : 'What-If Stress Lab'}
                        </button>

                        {onSendPdf && (
                          <button
                            onClick={onSendPdf}
                            disabled={sendingPdf}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: '0.35rem',
                              padding: '0.4rem 0.8rem',
                              borderRadius: '8px',
                              background: 'linear-gradient(135deg, #a855f7 0%, #ec4899 100%)',
                              border: 'none',
                              color: '#ffffff',
                              fontSize: '0.78rem',
                              fontWeight: 700,
                              cursor: sendingPdf ? 'not-allowed' : 'pointer',
                              opacity: sendingPdf ? 0.6 : 1
                            }}
                          >
                            <Send size={13} />
                            {sendingPdf ? 'Broadcasting...' : 'Export to TG'}
                          </button>
                        )}
                      </div>
                    </div>

                    {/* Filter Presets & Filter Drawer Toggle */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: '0.6rem', paddingTop: '0.65rem', borderTop: isDark ? '1px solid rgba(255,255,255,0.06)' : '1px solid #e2e8f0' }}>
                      {/* Presets Rows Container */}
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.6rem' }}>
                        {/* Strategy Presets */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', flexWrap: 'wrap' }}>
                          <span style={{ fontSize: '0.68rem', color: isDark ? '#94a3b8' : '#64748b', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.03em' }}>
                            SIGNALS:
                          </span>
                          {[
                            { id: 'all', label: 'All Signals' },
                            { id: 'safest', label: '🛡️ Safest' },
                            { id: 'high_value', label: '⚡ High Value' },
                            { id: 'ai_best_pick', label: '🎯 AI Best' },
                            { id: 'goals_engine', label: '⚽ Goals Engine' },
                            { id: 'goals_market', label: '⚽ Goals Markets' },
                            { id: 'high_odds', label: '🔥 Odds ≥ 3.0' }
                          ].map((btn) => {
                            const active = isStrategyActive(btn.id)
                            return (
                              <button
                                key={btn.id}
                                onClick={() => handleStrategyPreset(btn.id)}
                                title={active ? 'Currently active (Click to toggle off)' : `Filter by ${btn.label}`}
                                style={{
                                  padding: '0.22rem 0.6rem',
                                  borderRadius: '6px',
                                  fontSize: '0.72rem',
                                  fontWeight: active ? 700 : 600,
                                  cursor: 'pointer',
                                  transition: 'all 0.15s ease',
                                  border: active
                                    ? '1px solid #c084fc'
                                    : isDark
                                    ? '1px solid rgba(255,255,255,0.1)'
                                    : '1px solid #cbd5e1',
                                  background: active
                                    ? 'linear-gradient(135deg, #a855f7 0%, #6366f1 100%)'
                                    : isDark
                                    ? 'rgba(255,255,255,0.05)'
                                    : '#f1f5f9',
                                  color: active ? '#ffffff' : isDark ? '#cbd5e1' : '#475569',
                                  boxShadow: active ? '0 2px 8px rgba(168, 85, 247, 0.4)' : 'none',
                                  display: 'inline-flex',
                                  alignItems: 'center',
                                  gap: '0.25rem'
                                }}
                              >
                                {active && btn.id !== 'all' && <span style={{ fontSize: '0.7rem' }}>✓</span>}
                                {btn.label}
                              </button>
                            )
                          })}
                        </div>

                        {/* Advanced Filters Toggle Button */}
                        <button
                          onClick={() => setShowAdvancedFilters(!showAdvancedFilters)}
                          style={{
                            background: showAdvancedFilters ? (isDark ? 'rgba(96, 165, 250, 0.15)' : '#eff6ff') : 'transparent',
                            border: showAdvancedFilters ? '1px solid rgba(96, 165, 250, 0.35)' : 'none',
                            padding: showAdvancedFilters ? '0.22rem 0.55rem' : '0.2rem',
                            borderRadius: '6px',
                            color: '#60a5fa',
                            fontSize: '0.74rem',
                            fontWeight: 700,
                            cursor: 'pointer',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '0.25rem'
                          }}
                        >
                          <Sliders size={13} />
                          {showAdvancedFilters ? 'Hide Granular Filters' : 'Advanced Filters & Odds'}
                          {showAdvancedFilters ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                        </button>
                      </div>

                      {/* Time Range Presets Row */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.35rem', flexWrap: 'wrap' }}>
                        <span style={{ fontSize: '0.68rem', color: isDark ? '#94a3b8' : '#64748b', fontWeight: 700, textTransform: 'uppercase', letterSpacing: '0.03em' }}>
                          TIME PERIOD:
                        </span>
                        {[
                          { id: 'all', label: '🌐 All Time' },
                          { id: 'today', label: '📅 Today' },
                          { id: 'yesterday', label: '⏪ Yesterday' },
                          { id: 'last24h', label: '⏱️ Last 24h' },
                          { id: 'last3d', label: '🗓️ 3 Days' },
                          { id: 'last7d', label: '🗓️ 7 Days' },
                          { id: 'last30d', label: '🗓️ 30 Days' },
                          { id: 'last100', label: '🔢 Last 100 Bets' }
                        ].map((btn) => {
                          const active = simFilterTimeRange === btn.id
                          return (
                            <button
                              key={btn.id}
                              onClick={() => handleTimePreset(btn.id)}
                              title={active ? 'Currently active time filter' : `Filter by ${btn.label}`}
                              style={{
                                padding: '0.22rem 0.6rem',
                                borderRadius: '6px',
                                fontSize: '0.72rem',
                                fontWeight: active ? 700 : 600,
                                cursor: 'pointer',
                                transition: 'all 0.15s ease',
                                border: active
                                  ? '1px solid #38bdf8'
                                  : isDark
                                  ? '1px solid rgba(255,255,255,0.1)'
                                  : '1px solid #cbd5e1',
                                background: active
                                  ? 'linear-gradient(135deg, #0284c7 0%, #2563eb 100%)'
                                  : isDark
                                  ? 'rgba(255,255,255,0.05)'
                                  : '#f1f5f9',
                                color: active ? '#ffffff' : isDark ? '#cbd5e1' : '#475569',
                                boxShadow: active ? '0 2px 8px rgba(37, 99, 235, 0.4)' : 'none',
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: '0.25rem'
                              }}
                            >
                              {active && btn.id !== 'all' && <span style={{ fontSize: '0.7rem' }}>✓</span>}
                              {btn.label}
                            </button>
                          )
                        })}

                        {activeFilterCount > 0 && (
                          <button
                            onClick={resetFilters}
                            title="Reset all filters back to default"
                            style={{
                              padding: '0.22rem 0.6rem',
                              borderRadius: '6px',
                              fontSize: '0.72rem',
                              fontWeight: 700,
                              cursor: 'pointer',
                              border: '1px solid rgba(239, 68, 68, 0.35)',
                              background: 'rgba(239, 68, 68, 0.15)',
                              color: '#ef4444',
                              marginLeft: '0.35rem'
                            }}
                          >
                            Reset All ({activeFilterCount})
                          </button>
                        )}
                      </div>

                      {/* Active Filters Badges Chips Bar */}
                      {activeFilterCount > 0 && (
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: '0.4rem',
                            flexWrap: 'wrap',
                            paddingTop: '0.45rem',
                            marginTop: '0.15rem',
                            borderTop: isDark ? '1px dashed rgba(255,255,255,0.08)' : '1px dashed #cbd5e1'
                          }}
                        >
                          <span style={{ fontSize: '0.67rem', color: isDark ? '#94a3b8' : '#64748b', fontWeight: 700 }}>
                            ACTIVE FILTERS:
                          </span>
                          {simFilterStrategy !== 'all' && (
                            <span
                              style={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: '0.25rem',
                                padding: '0.15rem 0.5rem',
                                borderRadius: '14px',
                                background: 'rgba(168, 85, 247, 0.18)',
                                border: '1px solid rgba(168, 85, 247, 0.35)',
                                color: isDark ? '#d8b4fe' : '#7e22ce',
                                fontSize: '0.7rem',
                                fontWeight: 700
                              }}
                            >
                              Strategy: {simFilterStrategy === 'goals' ? 'Goals Engine' : simFilterStrategy === 'ai_best_pick' ? 'AI Best' : simFilterStrategy === 'high_value' ? 'High Value' : 'Safest'}
                              <X size={12} style={{ cursor: 'pointer', opacity: 0.8 }} onClick={() => setSimFilterStrategy('all')} />
                            </span>
                          )}
                          {simFilterTimeRange !== 'all' && (
                            <span
                              style={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: '0.25rem',
                                padding: '0.15rem 0.5rem',
                                borderRadius: '14px',
                                background: 'rgba(2, 132, 199, 0.18)',
                                border: '1px solid rgba(2, 132, 199, 0.35)',
                                color: isDark ? '#7dd3fc' : '#0369a1',
                                fontSize: '0.7rem',
                                fontWeight: 700
                              }}
                            >
                              Time: {timeRangeLabels[simFilterTimeRange] || simFilterTimeRange}
                              <X size={12} style={{ cursor: 'pointer', opacity: 0.8 }} onClick={() => setSimFilterTimeRange('all')} />
                            </span>
                          )}
                          {simFilterMarket !== 'all' && (
                            <span
                              style={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: '0.25rem',
                                padding: '0.15rem 0.5rem',
                                borderRadius: '14px',
                                background: 'rgba(16, 185, 129, 0.18)',
                                border: '1px solid rgba(16, 185, 129, 0.35)',
                                color: isDark ? '#6ee7b7' : '#047857',
                                fontSize: '0.7rem',
                                fontWeight: 700
                              }}
                            >
                              Market: {simFilterMarket === 'goals_all' ? 'Goals (All)' : simFilterMarket}
                              <X size={12} style={{ cursor: 'pointer', opacity: 0.8 }} onClick={() => setSimFilterMarket('all')} />
                            </span>
                          )}
                          {(simFilterMinOdds !== '' || simFilterMaxOdds !== '') && (
                            <span
                              style={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: '0.25rem',
                                padding: '0.15rem 0.5rem',
                                borderRadius: '14px',
                                background: 'rgba(245, 158, 11, 0.18)',
                                border: '1px solid rgba(245, 158, 11, 0.35)',
                                color: isDark ? '#fcd34d' : '#b45309',
                                fontSize: '0.7rem',
                                fontWeight: 700
                              }}
                            >
                              Odds: {simFilterMinOdds ? `≥ ${simFilterMinOdds}` : ''} {simFilterMinOdds && simFilterMaxOdds ? '·' : ''} {simFilterMaxOdds ? `≤ ${simFilterMaxOdds}` : ''}
                              <X size={12} style={{ cursor: 'pointer', opacity: 0.8 }} onClick={() => { setSimFilterMinOdds(''); setSimFilterMaxOdds(''); }} />
                            </span>
                          )}
                          {simFilterMinProb > 0 && (
                            <span
                              style={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: '0.25rem',
                                padding: '0.15rem 0.5rem',
                                borderRadius: '14px',
                                background: 'rgba(59, 130, 246, 0.18)',
                                border: '1px solid rgba(59, 130, 246, 0.35)',
                                color: isDark ? '#93c5fd' : '#1d4ed8',
                                fontSize: '0.7rem',
                                fontWeight: 700
                              }}
                            >
                              Prob: ≥ {simFilterMinProb}%
                              <X size={12} style={{ cursor: 'pointer', opacity: 0.8 }} onClick={() => setSimFilterMinProb(0)} />
                            </span>
                          )}
                          {simFilterOutcome !== 'all' && (
                            <span
                              style={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: '0.25rem',
                                padding: '0.15rem 0.5rem',
                                borderRadius: '14px',
                                background: 'rgba(139, 92, 246, 0.18)',
                                border: '1px solid rgba(139, 92, 246, 0.35)',
                                color: isDark ? '#c4b5fd' : '#6d28d9',
                                fontSize: '0.7rem',
                                fontWeight: 700
                              }}
                            >
                              Outcome: {simFilterOutcome.toUpperCase()}
                              <X size={12} style={{ cursor: 'pointer', opacity: 0.8 }} onClick={() => setSimFilterOutcome('all')} />
                            </span>
                          )}
                          {simFilterTeam.trim() !== '' && (
                            <span
                              style={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: '0.25rem',
                                padding: '0.15rem 0.5rem',
                                borderRadius: '14px',
                                background: 'rgba(236, 72, 153, 0.18)',
                                border: '1px solid rgba(236, 72, 153, 0.35)',
                                color: isDark ? '#f472b6' : '#be185d',
                                fontSize: '0.7rem',
                                fontWeight: 700
                              }}
                            >
                              Team: "{simFilterTeam.trim()}"
                              <X size={12} style={{ cursor: 'pointer', opacity: 0.8 }} onClick={() => setSimFilterTeam('')} />
                            </span>
                          )}
                          {(simFilterRoundMin !== '' || simFilterRoundMax !== '') && (
                            <span
                              style={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                gap: '0.25rem',
                                padding: '0.15rem 0.5rem',
                                borderRadius: '14px',
                                background: 'rgba(20, 184, 166, 0.18)',
                                border: '1px solid rgba(20, 184, 166, 0.35)',
                                color: isDark ? '#5eead4' : '#0f766e',
                                fontSize: '0.7rem',
                                fontWeight: 700
                              }}
                            >
                              Round: {simFilterRoundMin || '1'} - {simFilterRoundMax || '38'}
                              <X size={12} style={{ cursor: 'pointer', opacity: 0.8 }} onClick={() => { setSimFilterRoundMin(''); setSimFilterRoundMax(''); }} />
                            </span>
                          )}
                        </div>
                      )}
                    </div>

                    {/* Collapsible Advanced Filters Panel */}
                    {showAdvancedFilters && (
                      <div
                        style={{
                          display: 'grid',
                          gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))',
                          gap: '0.75rem',
                          marginTop: '0.85rem',
                          paddingTop: '0.85rem',
                          borderTop: isDark ? '1px dashed rgba(255,255,255,0.1)' : '1px dashed #cbd5e1'
                        }}
                      >
                        <div>
                          <label style={{ fontSize: '0.68rem', color: isDark ? '#94a3b8' : '#64748b', display: 'block', marginBottom: '0.2rem', fontWeight: 700 }}>
                            Strategy / Engine
                          </label>
                          <select
                            value={simFilterStrategy}
                            onChange={(e) => setSimFilterStrategy(e.target.value)}
                            style={{
                              width: '100%',
                              padding: '0.3rem 0.45rem',
                              borderRadius: '6px',
                              background: isDark ? '#0f172a' : '#ffffff',
                              border: isDark ? '1px solid rgba(255,255,255,0.1)' : '1px solid #cbd5e1',
                              color: isDark ? '#f8fafc' : '#0f172a',
                              fontSize: '0.75rem',
                              fontWeight: 600
                            }}
                          >
                            <option value="all">All Strategies</option>
                            <option value="safest">🛡️ Safest Pick</option>
                            <option value="high_value">⚡ High Value</option>
                            <option value="ai_best_pick">🎯 AI Best Pick</option>
                            <option value="goals">⚽ Goals Engine (O/U 2.5 & 3.5)</option>
                          </select>
                        </div>

                        <div>
                          <label style={{ fontSize: '0.68rem', color: isDark ? '#94a3b8' : '#64748b', display: 'block', marginBottom: '0.2rem', fontWeight: 700 }}>
                            Time Period / Range
                          </label>
                          <select
                            value={simFilterTimeRange}
                            onChange={(e) => setSimFilterTimeRange(e.target.value)}
                            style={{
                              width: '100%',
                              padding: '0.3rem 0.45rem',
                              borderRadius: '6px',
                              background: isDark ? '#0f172a' : '#ffffff',
                              border: isDark ? '1px solid rgba(255,255,255,0.1)' : '1px solid #cbd5e1',
                              color: isDark ? '#f8fafc' : '#0f172a',
                              fontSize: '0.75rem',
                              fontWeight: 600
                            }}
                          >
                            <option value="all">🌐 All Time (Full History)</option>
                            <option value="today">📅 Today (00:00 - now)</option>
                            <option value="yesterday">⏪ Yesterday (Full day)</option>
                            <option value="last24h">⏱️ Past 24 Hours</option>
                            <option value="last3d">🗓️ Past 3 Days</option>
                            <option value="last7d">🗓️ Past 7 Days</option>
                            <option value="last30d">🗓️ Past 30 Days</option>
                            <option value="last100">🔢 Most Recent 100 Bets</option>
                            <option value="last250">🔢 Most Recent 250 Bets</option>
                            <option value="last500">🔢 Most Recent 500 Bets</option>
                          </select>
                        </div>

                        <div>
                          <label style={{ fontSize: '0.68rem', color: isDark ? '#94a3b8' : '#64748b', display: 'block', marginBottom: '0.2rem', fontWeight: 700 }}>
                            Market Type
                          </label>
                          <select
                            value={simFilterMarket}
                            onChange={(e) => setSimFilterMarket(e.target.value)}
                            style={{
                              width: '100%',
                              padding: '0.3rem 0.45rem',
                              borderRadius: '6px',
                              background: isDark ? '#0f172a' : '#ffffff',
                              border: isDark ? '1px solid rgba(255,255,255,0.1)' : '1px solid #cbd5e1',
                              color: isDark ? '#f8fafc' : '#0f172a',
                              fontSize: '0.75rem'
                            }}
                          >
                            <option value="all">All Markets ({availableMarkets.length})</option>
                            <option value="goals_all">⚽ All Goals (Over/Under/GG)</option>
                            {availableMarkets.map((m) => (
                              <option key={m} value={m}>
                                {m}
                              </option>
                            ))}
                          </select>
                        </div>

                        <div>
                          <label style={{ fontSize: '0.68rem', color: isDark ? '#94a3b8' : '#64748b', display: 'block', marginBottom: '0.2rem' }}>
                            Odds Range (Min - Max)
                          </label>
                          <div style={{ display: 'flex', gap: '0.3rem', alignItems: 'center' }}>
                            <input
                              type="number"
                              step="0.1"
                              placeholder="Min"
                              value={simFilterMinOdds}
                              onChange={(e) => setSimFilterMinOdds(e.target.value)}
                              style={{
                                width: '50%',
                                padding: '0.3rem 0.4rem',
                                borderRadius: '6px',
                                background: isDark ? '#0f172a' : '#ffffff',
                                border: isDark ? '1px solid rgba(255,255,255,0.1)' : '1px solid #cbd5e1',
                                color: isDark ? '#f8fafc' : '#0f172a',
                                fontSize: '0.75rem',
                                textAlign: 'center'
                              }}
                            />
                            <span style={{ color: '#94a3b8', fontSize: '0.7rem' }}>-</span>
                            <input
                              type="number"
                              step="0.1"
                              placeholder="Max"
                              value={simFilterMaxOdds}
                              onChange={(e) => setSimFilterMaxOdds(e.target.value)}
                              style={{
                                width: '50%',
                                padding: '0.3rem 0.4rem',
                                borderRadius: '6px',
                                background: isDark ? '#0f172a' : '#ffffff',
                                border: isDark ? '1px solid rgba(255,255,255,0.1)' : '1px solid #cbd5e1',
                                color: isDark ? '#f8fafc' : '#0f172a',
                                fontSize: '0.75rem',
                                textAlign: 'center'
                              }}
                            />
                          </div>
                        </div>

                        <div>
                          <label style={{ fontSize: '0.68rem', color: isDark ? '#94a3b8' : '#64748b', display: 'block', marginBottom: '0.2rem' }}>
                            Min Confidence %
                          </label>
                          <select
                            value={simFilterMinProb}
                            onChange={(e) => setSimFilterMinProb(Number(e.target.value))}
                            style={{
                              width: '100%',
                              padding: '0.3rem 0.45rem',
                              borderRadius: '6px',
                              background: isDark ? '#0f172a' : '#ffffff',
                              border: isDark ? '1px solid rgba(255,255,255,0.1)' : '1px solid #cbd5e1',
                              color: isDark ? '#f8fafc' : '#0f172a',
                              fontSize: '0.75rem'
                            }}
                          >
                            <option value="0">All Confidences</option>
                            <option value="55">≥ 55% Confidence</option>
                            <option value="60">≥ 60% Confidence</option>
                            <option value="65">≥ 65% Confidence</option>
                            <option value="70">≥ 70% Confidence</option>
                          </select>
                        </div>

                        <div>
                          <label style={{ fontSize: '0.68rem', color: isDark ? '#94a3b8' : '#64748b', display: 'block', marginBottom: '0.2rem' }}>
                            Outcome Filter
                          </label>
                          <select
                            value={simFilterOutcome}
                            onChange={(e) => setSimFilterOutcome(e.target.value)}
                            style={{
                              width: '100%',
                              padding: '0.3rem 0.45rem',
                              borderRadius: '6px',
                              background: isDark ? '#0f172a' : '#ffffff',
                              border: isDark ? '1px solid rgba(255,255,255,0.1)' : '1px solid #cbd5e1',
                              color: isDark ? '#f8fafc' : '#0f172a',
                              fontSize: '0.75rem'
                            }}
                          >
                            <option value="all">All Outcomes (Won + Lost)</option>
                            <option value="won">Won Only</option>
                            <option value="lost">Lost Only</option>
                          </select>
                        </div>

                        <div>
                          <label style={{ fontSize: '0.68rem', color: isDark ? '#94a3b8' : '#64748b', display: 'block', marginBottom: '0.2rem' }}>
                            Team Search
                          </label>
                          <input
                            type="text"
                            placeholder="e.g. Arsenal, Chelsea"
                            value={simFilterTeam}
                            onChange={(e) => setSimFilterTeam(e.target.value)}
                            style={{
                              width: '100%',
                              padding: '0.3rem 0.45rem',
                              borderRadius: '6px',
                              background: isDark ? '#0f172a' : '#ffffff',
                              border: isDark ? '1px solid rgba(255,255,255,0.1)' : '1px solid #cbd5e1',
                              color: isDark ? '#f8fafc' : '#0f172a',
                              fontSize: '0.75rem'
                            }}
                          />
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Empty state alert banner when filters yield 0 matches */}
                  {filteredPicks.length === 0 && (
                    <div
                      style={{
                        background: isDark ? 'rgba(245, 158, 11, 0.1)' : '#fffbeb',
                        border: '1.5px solid rgba(245, 158, 11, 0.4)',
                        borderRadius: '12px',
                        padding: '1.1rem 1.4rem',
                        marginBottom: '1rem',
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        flexWrap: 'wrap',
                        gap: '1rem',
                        boxShadow: '0 4px 14px rgba(245, 158, 11, 0.12)'
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.85rem', flex: 1, minWidth: '280px' }}>
                        <div
                          style={{
                            width: '40px',
                            height: '40px',
                            borderRadius: '10px',
                            background: 'rgba(245, 158, 11, 0.2)',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            flexShrink: 0
                          }}
                        >
                          <AlertTriangle size={22} color="#f59e0b" />
                        </div>
                        <div>
                          <div style={{ fontWeight: 800, fontSize: '0.92rem', color: isDark ? '#fbbf24' : '#b45309' }}>
                            No settled bets match the selected filter{simFilterTimeRange !== 'all' ? ` (${timeRangeLabels[simFilterTimeRange] || simFilterTimeRange})` : ''}
                          </div>
                          <div style={{ fontSize: '0.78rem', color: isDark ? '#cbd5e1' : '#78350f', marginTop: '0.2rem', lineHeight: '1.4' }}>
                            {simFilterTimeRange === 'today' ? (
                              <>
                                No tracked bets have been settled yet today. If matches have already finished, settlement may be delayed - check the scraper logs.
                                {rawPicks.length > 0 ? ` Your database contains ${rawPicks.length} settled bets from earlier periods.` : ' No settled picks were found in this scope.'}
                              </>
                            ) : rawPicks.length > 0 ? (
                              `Your database contains ${rawPicks.length} total settled bets, but none match the current filter criteria.`
                            ) : (
                              'No settled bets are recorded yet in this database.'
                            )}
                          </div>
                        </div>
                      </div>
                      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                        {simFilterTimeRange !== 'all' && rawPicks.length > 0 && (
                          <button
                            onClick={() => setSimFilterTimeRange('all')}
                            style={{
                              padding: '0.45rem 0.9rem',
                              borderRadius: '8px',
                              background: 'linear-gradient(135deg, #a855f7 0%, #6366f1 100%)',
                              border: 'none',
                              color: '#fff',
                              fontWeight: 700,
                              fontSize: '0.78rem',
                              cursor: 'pointer',
                              boxShadow: '0 2px 8px rgba(168,85,247,0.35)'
                            }}
                          >
                            View All Time ({rawPicks.length} bets)
                          </button>
                        )}
                        <button
                          onClick={resetFilters}
                          style={{
                            padding: '0.45rem 0.9rem',
                            borderRadius: '8px',
                            background: isDark ? 'rgba(255,255,255,0.08)' : '#f1f5f9',
                            border: isDark ? '1px solid rgba(255,255,255,0.15)' : '1px solid #cbd5e1',
                            color: isDark ? '#f8fafc' : '#334155',
                            fontWeight: 700,
                            fontSize: '0.78rem',
                            cursor: 'pointer'
                          }}
                        >
                          Reset Filters
                        </button>
                      </div>
                    </div>
                  )}

                  {/* ⚽ GOALS ENGINE SHOWCASE PANEL */}
                  {data?.paperTracking?.goalsEngine && (() => {
                    const engine = data.paperTracking.goalsEngine
                    const pick = engine.next
                    return (
                      <div
                        style={{
                          background: isDark
                            ? 'linear-gradient(135deg, rgba(6, 182, 212, 0.08) 0%, rgba(59, 130, 246, 0.08) 100%)'
                            : 'linear-gradient(135deg, #ecfeff 0%, #eff6ff 100%)',
                          border: '1.5px solid rgba(6, 182, 212, 0.35)',
                          borderRadius: '14px',
                          padding: '1.1rem 1.4rem',
                          marginBottom: '1rem',
                          boxShadow: '0 8px 24px rgba(6, 182, 212, 0.08)'
                        }}
                      >
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.75rem', marginBottom: '0.85rem' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                            <div
                              style={{
                                width: '34px',
                                height: '34px',
                                borderRadius: '9px',
                                background: 'rgba(6, 182, 212, 0.2)',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                fontSize: '1.1rem'
                              }}
                            >
                              ⚽
                            </div>
                            <div>
                              <div style={{ fontSize: '0.96rem', fontWeight: 800, color: '#06b6d4', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                                Goals Engine — Over / Under 2.5 &amp; 3.5
                                <span
                                  style={{
                                    fontSize: '0.68rem',
                                    fontWeight: 800,
                                    padding: '0.15rem 0.55rem',
                                    borderRadius: '20px',
                                    background: 'rgba(6, 182, 212, 0.18)',
                                    color: '#06b6d4',
                                    border: '1px solid rgba(6, 182, 212, 0.4)'
                                  }}
                                >
                                  Adaptive Multi-Market
                                </span>
                              </div>
                              <div style={{ fontSize: '0.74rem', color: isDark ? '#94a3b8' : '#64748b' }}>
                                One pick per round dynamically chosen across 4 goal lines: Over 2.5, Under 2.5, Over 3.5, and Under 3.5.
                              </div>
                            </div>
                          </div>

                          <button
                            onClick={() => {
                              setSimFilterStrategy('goals')
                              setSimFilterMarket('all')
                              setSimBetLogPage(1)
                            }}
                            style={{
                              padding: '0.4rem 0.85rem',
                              borderRadius: '8px',
                              background: simFilterStrategy === 'goals' ? '#06b6d4' : 'rgba(6, 182, 212, 0.15)',
                              color: simFilterStrategy === 'goals' ? '#ffffff' : '#06b6d4',
                              border: '1px solid rgba(6, 182, 212, 0.4)',
                              fontSize: '0.78rem',
                              fontWeight: 800,
                              cursor: 'pointer',
                              transition: 'all 0.15s ease'
                            }}
                          >
                            {simFilterStrategy === 'goals' ? '✓ Filtering Goals Engine' : '⚡ View Goals Engine Replay'}
                          </button>
                        </div>

                        {pick ? (
                          <div
                            style={{
                              background: isDark ? 'rgba(0,0,0,0.25)' : '#ffffff',
                              border: isDark ? '1px solid rgba(255,255,255,0.08)' : '1px solid #cbd5e1',
                              borderRadius: '10px',
                              padding: '0.85rem 1rem',
                              display: 'flex',
                              justifyContent: 'space-between',
                              alignItems: 'center',
                              flexWrap: 'wrap',
                              gap: '0.75rem',
                              marginBottom: '0.75rem'
                            }}
                          >
                            <div>
                              <span style={{ fontSize: '0.68rem', fontWeight: 800, color: '#06b6d4', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
                                NEXT UPCOMING QUALIFYING SELECTION
                              </span>
                              <div style={{ fontSize: '0.98rem', fontWeight: 800, color: isDark ? '#f8fafc' : '#0f172a', marginTop: '0.15rem' }}>
                                {pick.home} <span style={{ opacity: 0.5, fontWeight: 400 }}>vs</span> {pick.away}
                              </div>
                              <div style={{ fontSize: '0.75rem', color: isDark ? '#94a3b8' : '#64748b', marginTop: '0.1rem' }}>
                                Target Market: <strong style={{ color: '#06b6d4' }}>{pick.market}</strong> · One recorded choice before kickoff
                              </div>
                            </div>

                            <div style={{ display: 'flex', alignItems: 'center', gap: '1.25rem' }}>
                              <div style={{ textAlign: 'right' }}>
                                <span style={{ fontSize: '0.68rem', color: isDark ? '#94a3b8' : '#64748b' }}>Learned Prob</span>
                                <div style={{ fontSize: '1.1rem', fontWeight: 900, color: '#10b981' }}>
                                  {Math.round(pick.probability || 0)}%
                                </div>
                              </div>
                              <div style={{ textAlign: 'right' }}>
                                <span style={{ fontSize: '0.68rem', color: isDark ? '#94a3b8' : '#64748b' }}>Odds</span>
                                <div style={{ fontSize: '1.1rem', fontWeight: 900, color: '#f59e0b' }}>
                                  @{pick.odds}
                                </div>
                              </div>
                            </div>
                          </div>
                        ) : (
                          <div style={{ padding: '0.65rem 0', fontSize: '0.78rem', color: isDark ? '#94a3b8' : '#64748b', fontStyle: 'italic' }}>
                            Waiting for upcoming fixtures with paired goal-market odds quotes...
                          </div>
                        )}

                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '0.72rem', color: isDark ? '#94a3b8' : '#64748b' }}>
                          <span>
                            📊 <strong>{engine.samples?.total || 0}</strong> market snapshots captured · <strong>{engine.samples?.settled || 0}</strong> settled for calibration learning
                          </span>
                          <span style={{ opacity: 0.75 }}>
                            Unified 4-market adaptive selection with single shared bankroll ledger
                          </span>
                        </div>
                      </div>
                    )
                  })()}

                  {/* ── 10 EXECUTIVE KPI METRIC CARDS ── */}
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(auto-fit, minmax(130px, 1fr))',
                      gap: '0.65rem',
                      marginBottom: '1rem'
                    }}
                  >
                    {/* Simulated Balance */}
                    <div
                      style={{
                        background: isDark ? 'rgba(255,255,255,0.03)' : '#f8fafc',
                        border: isDark ? '1px solid rgba(255,255,255,0.08)' : '1px solid #e2e8f0',
                        borderRadius: '10px',
                        padding: '0.75rem'
                      }}
                    >
                      <span style={{ fontSize: '0.68rem', color: isDark ? '#94a3b8' : '#64748b', fontWeight: 600 }}>
                        SIMULATED BALANCE
                      </span>
                      <div style={{ fontSize: '1.15rem', fontWeight: 900, color: isDark ? '#ffffff' : '#0f172a', marginTop: '0.2rem' }}>
                        {simResults.currentBalance.toLocaleString(undefined, { maximumFractionDigits: 0 })} u
                      </div>
                      <span style={{ fontSize: '0.65rem', opacity: 0.7 }}>Base: {baseCapital.toLocaleString()} u</span>
                    </div>

                    {/* Net Profit / Loss */}
                    <div
                      style={{
                        background: isDark ? 'rgba(255,255,255,0.03)' : '#f8fafc',
                        border: isDark ? '1px solid rgba(255,255,255,0.08)' : '1px solid #e2e8f0',
                        borderRadius: '10px',
                        padding: '0.75rem'
                      }}
                    >
                      <span style={{ fontSize: '0.68rem', color: isDark ? '#94a3b8' : '#64748b', fontWeight: 600 }}>
                        NET PROFIT / LOSS
                      </span>
                      <div
                        style={{
                          fontSize: '1.15rem',
                          fontWeight: 900,
                          color: simResults.netProfit >= 0 ? successColor : dangerColor,
                          marginTop: '0.2rem'
                        }}
                      >
                        {simResults.netProfit >= 0 ? '+' : ''}
                        {simResults.netProfit.toLocaleString(undefined, { maximumFractionDigits: 0 })} u
                      </div>
                      <span style={{ fontSize: '0.65rem', color: simResults.netProfit >= 0 ? successColor : dangerColor }}>
                        {simResults.netProfit >= 0 ? 'Profitable Replay' : 'Drawdown State'}
                      </span>
                    </div>

                    {/* ROC (Growth) */}
                    <div
                      style={{
                        background: isDark ? 'rgba(255,255,255,0.03)' : '#f8fafc',
                        border: isDark ? '1px solid rgba(255,255,255,0.08)' : '1px solid #e2e8f0',
                        borderRadius: '10px',
                        padding: '0.75rem'
                      }}
                    >
                      <span style={{ fontSize: '0.68rem', color: isDark ? '#94a3b8' : '#64748b', fontWeight: 600 }}>
                        BANKROLL GROWTH (ROC)
                      </span>
                      <div
                        style={{
                          fontSize: '1.15rem',
                          fontWeight: 900,
                          color: simResults.overallRoc >= 0 ? successColor : dangerColor,
                          marginTop: '0.2rem'
                        }}
                      >
                        {simResults.overallRoc >= 0 ? '+' : ''}
                        {simResults.overallRoc}%
                      </div>
                      <span style={{ fontSize: '0.65rem', opacity: 0.7 }}>Return on Capital</span>
                    </div>

                    {/* Yield (ROI) */}
                    <div
                      style={{
                        background: isDark ? 'rgba(255,255,255,0.03)' : '#f8fafc',
                        border: isDark ? '1px solid rgba(255,255,255,0.08)' : '1px solid #e2e8f0',
                        borderRadius: '10px',
                        padding: '0.75rem'
                      }}
                    >
                      <span style={{ fontSize: '0.68rem', color: isDark ? '#94a3b8' : '#64748b', fontWeight: 600 }}>
                        YIELD (ROI)
                      </span>
                      <div
                        style={{
                          fontSize: '1.15rem',
                          fontWeight: 900,
                          color: simResults.overallRoi >= 0 ? successColor : dangerColor,
                          marginTop: '0.2rem'
                        }}
                      >
                        {simResults.overallRoi >= 0 ? '+' : ''}
                        {simResults.overallRoi}%
                      </div>
                      <span style={{ fontSize: '0.65rem', opacity: 0.7 }}>Return on Turnover</span>
                    </div>

                    {/* Profit Factor */}
                    <div
                      style={{
                        background: isDark ? 'rgba(255,255,255,0.03)' : '#f8fafc',
                        border: isDark ? '1px solid rgba(255,255,255,0.08)' : '1px solid #e2e8f0',
                        borderRadius: '10px',
                        padding: '0.75rem'
                      }}
                    >
                      <span style={{ fontSize: '0.68rem', color: isDark ? '#94a3b8' : '#64748b', fontWeight: 600 }}>
                        PROFIT FACTOR
                      </span>
                      <div
                        style={{
                          fontSize: '1.15rem',
                          fontWeight: 900,
                          color: Number(simResults.profitFactor) >= 1.3 ? successColor : Number(simResults.profitFactor) >= 1 ? warningColor : dangerColor,
                          marginTop: '0.2rem'
                        }}
                      >
                        {simResults.profitFactor}
                      </div>
                      <span style={{ fontSize: '0.65rem', opacity: 0.7 }}>Gross Win / Loss</span>
                    </div>

                    {/* Settled Bets & Win Rate */}
                    <div
                      style={{
                        background: isDark ? 'rgba(255,255,255,0.03)' : '#f8fafc',
                        border: isDark ? '1px solid rgba(255,255,255,0.08)' : '1px solid #e2e8f0',
                        borderRadius: '10px',
                        padding: '0.75rem'
                      }}
                    >
                      <span style={{ fontSize: '0.68rem', color: isDark ? '#94a3b8' : '#64748b', fontWeight: 600 }}>
                        WIN RATE
                      </span>
                      <div style={{ fontSize: '1.15rem', fontWeight: 900, color: successColor, marginTop: '0.2rem' }}>
                        {simResults.strategyStats.overall.winRate}%
                      </div>
                      <span style={{ fontSize: '0.65rem', opacity: 0.7 }}>
                        {simResults.strategyStats.overall.won}W / {simResults.strategyStats.overall.played} settled
                      </span>
                    </div>

                    {/* Max Drawdown */}
                    <div
                      style={{
                        background: isDark ? 'rgba(255,255,255,0.03)' : '#f8fafc',
                        border: isDark ? '1px solid rgba(255,255,255,0.08)' : '1px solid #e2e8f0',
                        borderRadius: '10px',
                        padding: '0.75rem'
                      }}
                    >
                      <span style={{ fontSize: '0.68rem', color: isDark ? '#94a3b8' : '#64748b', fontWeight: 600 }}>
                        MAX DRAWDOWN
                      </span>
                      <div style={{ fontSize: '1.15rem', fontWeight: 900, color: dangerColor, marginTop: '0.2rem' }}>
                        -{simResults.maxDrawdownUnits.toLocaleString(undefined, { maximumFractionDigits: 0 })} u
                      </div>
                      <span style={{ fontSize: '0.65rem', color: dangerColor }}>
                        {simResults.maxDrawdownPct.toFixed(1)}% peak drop
                      </span>
                    </div>

                    {/* Max Streaks */}
                    <div
                      style={{
                        background: isDark ? 'rgba(255,255,255,0.03)' : '#f8fafc',
                        border: isDark ? '1px solid rgba(255,255,255,0.08)' : '1px solid #e2e8f0',
                        borderRadius: '10px',
                        padding: '0.75rem'
                      }}
                    >
                      <span style={{ fontSize: '0.68rem', color: isDark ? '#94a3b8' : '#64748b', fontWeight: 600 }}>
                        MAX STREAKS
                      </span>
                      <div style={{ fontSize: '1.15rem', fontWeight: 900, marginTop: '0.2rem', display: 'flex', gap: '0.3rem' }}>
                        <span style={{ color: successColor }}>{simResults.maxWinStreak}W</span>
                        <span style={{ opacity: 0.4 }}>/</span>
                        <span style={{ color: dangerColor }}>{simResults.maxLossStreak}L</span>
                      </div>
                      <span style={{ fontSize: '0.65rem', opacity: 0.7 }}>Consecutive Max</span>
                    </div>

                    {/* Total Staked */}
                    <div
                      style={{
                        background: isDark ? 'rgba(255,255,255,0.03)' : '#f8fafc',
                        border: isDark ? '1px solid rgba(255,255,255,0.08)' : '1px solid #e2e8f0',
                        borderRadius: '10px',
                        padding: '0.75rem'
                      }}
                    >
                      <span style={{ fontSize: '0.68rem', color: isDark ? '#94a3b8' : '#64748b', fontWeight: 600 }}>
                        TOTAL TURNOVER
                      </span>
                      <div style={{ fontSize: '1.15rem', fontWeight: 900, color: isDark ? '#e2e8f0' : '#1e293b', marginTop: '0.2rem' }}>
                        {simResults.totalStakedAmount.toLocaleString(undefined, { maximumFractionDigits: 0 })} u
                      </div>
                      <span style={{ fontSize: '0.65rem', opacity: 0.7 }}>Avg: {simResults.avgStake} u / bet</span>
                    </div>

                    {/* Max Single Stake */}
                    <div
                      style={{
                        background: isDark ? 'rgba(255,255,255,0.03)' : '#f8fafc',
                        border: isDark ? '1px solid rgba(255,255,255,0.08)' : '1px solid #e2e8f0',
                        borderRadius: '10px',
                        padding: '0.75rem'
                      }}
                    >
                      <span style={{ fontSize: '0.68rem', color: isDark ? '#94a3b8' : '#64748b', fontWeight: 600 }}>
                        PEAK SINGLE BET
                      </span>
                      <div style={{ fontSize: '1.15rem', fontWeight: 900, color: '#f59e0b', marginTop: '0.2rem' }}>
                        {simResults.maxSingleStake.toLocaleString(undefined, { maximumFractionDigits: 0 })} u
                      </div>
                      <span style={{ fontSize: '0.65rem', opacity: 0.7 }}>Max Stake Escalation</span>
                    </div>
                  </div>

                  {/* ══════════════════════════════════════════════════════════════════
                      ⭐ SHOWCASE PANEL: "MINIMUM CAPITAL NEEDED FOR THIS REPLAY"
                      (Accurate starting capital required to fund every round and never bust)
                      ══════════════════════════════════════════════════════════════════ */}
                  <div
                    style={{
                      background: isDark
                        ? 'linear-gradient(135deg, rgba(99, 102, 241, 0.08) 0%, rgba(168, 85, 247, 0.08) 100%)'
                        : 'linear-gradient(135deg, #eff6ff 0%, #f5f3ff 100%)',
                      border: isDark ? '1.5px solid rgba(139, 92, 246, 0.35)' : '1.5px solid #c4b5fd',
                      borderRadius: '14px',
                      padding: '1.1rem 1.4rem',
                      marginBottom: '1.25rem',
                      boxShadow: '0 8px 24px rgba(0, 0, 0, 0.12)'
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.75rem', marginBottom: '0.75rem' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                        <div
                          style={{
                            width: '32px',
                            height: '32px',
                            borderRadius: '8px',
                            background: 'rgba(168, 85, 247, 0.2)',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center'
                          }}
                        >
                          <CreditCard size={18} color="#c084fc" />
                        </div>
                        <div>
                          <div style={{ fontSize: '0.95rem', fontWeight: 800, color: isDark ? '#f8fafc' : '#1e1b4b', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                            Minimum Capital Needed for this Replay
                            <span
                              style={{
                                fontSize: '0.68rem',
                                fontWeight: 800,
                                padding: '0.15rem 0.6rem',
                                borderRadius: '20px',
                                background: simResults.isCapitalFunded ? 'rgba(34, 197, 94, 0.2)' : 'rgba(239, 68, 68, 0.2)',
                                color: simResults.isCapitalFunded ? '#4ade80' : '#ef4444',
                                border: `1px solid ${simResults.isCapitalFunded ? 'rgba(34,197,94,0.4)' : 'rgba(239,68,68,0.4)'}`
                              }}
                            >
                              {simResults.isCapitalFunded ? '✅ FULLY FUNDED' : '⚠️ CAPITAL DEFICIT'}
                            </span>
                          </div>
                          <div style={{ fontSize: '0.74rem', color: isDark ? '#94a3b8' : '#64748b' }}>
                            Calculated dynamically using base stake, unlimited loss recovery escalation, and simultaneous kickoff rounds.
                          </div>
                        </div>
                      </div>

                      <div style={{ display: 'flex', alignItems: 'center', gap: '1.5rem' }}>
                        <div style={{ textAlign: 'right' }}>
                          <span style={{ fontSize: '0.68rem', color: isDark ? '#94a3b8' : '#64748b', fontWeight: 700, textTransform: 'uppercase' }}>
                            EXACT REPLAY MINIMUM
                          </span>
                          <div style={{ fontSize: '1.55rem', fontWeight: 900, color: '#a855f7', lineHeight: 1.1 }}>
                            {simResults.minCapitalNeeded.toLocaleString()} u
                          </div>
                        </div>
                        <div style={{ textAlign: 'right', borderLeft: isDark ? '1px solid rgba(255,255,255,0.1)' : '1px solid #cbd5e1', paddingLeft: '1.5rem' }}>
                          <span style={{ fontSize: '0.68rem', color: isDark ? '#94a3b8' : '#64748b', fontWeight: 700, textTransform: 'uppercase' }}>
                            RECOMMENDED (+25% BUFFER)
                          </span>
                          <div style={{ fontSize: '1.55rem', fontWeight: 900, color: successColor, lineHeight: 1.1 }}>
                            {simResults.recommendedCapital.toLocaleString()} u
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Explainer and Funding Diagnostic */}
                    <div
                      style={{
                        background: isDark ? 'rgba(0, 0, 0, 0.25)' : 'rgba(255, 255, 255, 0.7)',
                        borderRadius: '9px',
                        padding: '0.75rem 1rem',
                        fontSize: '0.76rem',
                        color: isDark ? '#cbd5e1' : '#334155',
                        lineHeight: 1.5,
                        display: 'flex',
                        flexDirection: 'column',
                        gap: '0.4rem'
                      }}
                    >
                      <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.5rem' }}>
                        <span style={{ color: '#a855f7', fontWeight: 800 }}>💡 WHY THIS MATTERS:</span>
                        <span>
                          Drawdown alone (-{simResults.maxDrawdownUnits.toLocaleString()} u) isn't your minimum starting capital: that drop can happen after earlier profits accumulated.
                          The <strong>Minimum Starting Capital ({simResults.minCapitalNeeded.toLocaleString()} u)</strong> is the exact cash reserve required upfront to commit simultaneous round stakes (peak simultaneous exposure: <strong>{simResults.maxSimultaneousExposure.toLocaleString()} u</strong>) and fund every bet in this recorded sequence without ever reaching zero balance.
                        </span>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.2rem' }}>
                        <span style={{ fontWeight: 700, color: simResults.isCapitalFunded ? successColor : dangerColor }}>
                          {simResults.isCapitalFunded ? '• Status Check:' : '• Solvency Warning:'}
                        </span>
                        <span>
                          {simResults.isCapitalFunded ? (
                            <>
                              Your configured bankroll of <strong>{baseCapital.toLocaleString()} u</strong> is sufficient for this historical sequence, providing a safety margin of <strong>+{(baseCapital - simResults.minCapitalNeeded).toLocaleString()} u</strong>.
                            </>
                          ) : (
                            <>
                              Your starting bankroll of <strong>{baseCapital.toLocaleString()} u</strong> would have experienced a <strong>{(simResults.minCapitalNeeded - baseCapital).toLocaleString()} u shortfall</strong> at bet #{simResults.troughBetIdx} (Round {simResults.troughRoundNumber || '?'}). Increase bankroll to at least <strong>{simResults.minCapitalNeeded.toLocaleString()} u</strong>.
                            </>
                          )}
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* ══════════════════════════════════════════════════════════════════
                      ⭐ WHAT-IF? SCENARIO STRESS LAB (Interactive Auto-Adjustments)
                      ══════════════════════════════════════════════════════════════════ */}
                  {whatIfEnabled && whatIfResults && (
                    <div
                      style={{
                        background: isDark
                          ? 'linear-gradient(135deg, rgba(245, 158, 11, 0.08) 0%, rgba(239, 68, 68, 0.08) 100%)'
                          : 'linear-gradient(135deg, #fffbeb 0%, #fef2f2 100%)',
                        border: '1.5px solid rgba(245, 158, 11, 0.4)',
                        borderRadius: '14px',
                        padding: '1.1rem 1.4rem',
                        marginBottom: '1.25rem',
                        boxShadow: '0 8px 24px rgba(245, 158, 11, 0.08)'
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '0.75rem', marginBottom: '1rem' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.6rem' }}>
                          <div
                            style={{
                              width: '32px',
                              height: '32px',
                              borderRadius: '8px',
                              background: 'rgba(245, 158, 11, 0.25)',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center'
                            }}
                          >
                            <Flame size={18} color="#f59e0b" />
                          </div>
                          <div>
                            <div style={{ fontSize: '0.95rem', fontWeight: 800, color: '#f59e0b', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                              What-If? Scenario Stress Testing Simulator
                              <span
                                style={{
                                  fontSize: '0.68rem',
                                  fontWeight: 800,
                                  padding: '0.15rem 0.6rem',
                                  borderRadius: '20px',
                                  background: whatIfResults.riskBadgeColor + '25',
                                  color: whatIfResults.riskBadgeColor,
                                  border: `1px solid ${whatIfResults.riskBadgeColor}50`
                                }}
                              >
                                {whatIfResults.riskLabel}
                              </span>
                            </div>
                            <div style={{ fontSize: '0.74rem', color: isDark ? '#94a3b8' : '#64748b' }}>
                              Hypothetical stress model: recorded replay stays intact while stats auto-adjust below.
                            </div>
                          </div>
                        </div>

                        {/* Stress Test Input Controls */}
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem', flexWrap: 'wrap' }}>
                          <div>
                            <label style={{ fontSize: '0.68rem', color: isDark ? '#94a3b8' : '#64748b', display: 'block', fontWeight: 700, marginBottom: '0.2rem' }}>
                              EXTRA LOSS STREAK (+N)
                            </label>
                            <div style={{ display: 'flex', alignItems: 'center', gap: '0.3rem' }}>
                              <input
                                type="number"
                                min="1"
                                max="20"
                                value={whatIfExtraLosses}
                                onChange={(e) => setWhatIfExtraLosses(Math.max(1, Number(e.target.value) || 1))}
                                style={{
                                  width: '60px',
                                  padding: '0.3rem 0.45rem',
                                  borderRadius: '6px',
                                  background: isDark ? '#0f172a' : '#ffffff',
                                  border: '1px solid rgba(245, 158, 11, 0.4)',
                                  color: '#fbbf24',
                                  fontSize: '0.82rem',
                                  fontWeight: 800,
                                  textAlign: 'center'
                                }}
                              />
                              <div style={{ display: 'flex', gap: '0.2rem' }}>
                                {[2, 3, 5, 8].map((n) => (
                                  <button
                                    key={n}
                                    onClick={() => setWhatIfExtraLosses(n)}
                                    style={{
                                      padding: '0.25rem 0.45rem',
                                      borderRadius: '4px',
                                      fontSize: '0.68rem',
                                      fontWeight: 700,
                                      border: 'none',
                                      cursor: 'pointer',
                                      background: whatIfExtraLosses === n ? '#f59e0b' : 'rgba(255,255,255,0.06)',
                                      color: whatIfExtraLosses === n ? '#000000' : '#fbbf24'
                                    }}
                                  >
                                    +{n}
                                  </button>
                                ))}
                              </div>
                            </div>
                          </div>

                          <div>
                            <label style={{ fontSize: '0.68rem', color: isDark ? '#94a3b8' : '#64748b', display: 'block', fontWeight: 700, marginBottom: '0.2rem' }}>
                              RECOVERY WIN ODDS (@)
                            </label>
                            <input
                              type="number"
                              step="0.1"
                              min="1.1"
                              value={whatIfRecoveryOdds}
                              onChange={(e) => setWhatIfRecoveryOdds(e.target.value)}
                              style={{
                                width: '70px',
                                padding: '0.3rem 0.45rem',
                                borderRadius: '6px',
                                background: isDark ? '#0f172a' : '#ffffff',
                                border: '1px solid rgba(245, 158, 11, 0.4)',
                                color: '#fbbf24',
                                fontSize: '0.82rem',
                                fontWeight: 800,
                                textAlign: 'center'
                              }}
                            />
                          </div>

                          <div>
                            <label style={{ fontSize: '0.68rem', color: isDark ? '#94a3b8' : '#64748b', display: 'block', fontWeight: 700, marginBottom: '0.2rem' }}>
                              STRESS INJECTION POINT
                            </label>
                            <select
                              value={whatIfPlacement}
                              onChange={(e) => setWhatIfPlacement(e.target.value)}
                              style={{
                                padding: '0.3rem 0.5rem',
                                borderRadius: '6px',
                                background: isDark ? '#0f172a' : '#ffffff',
                                border: '1px solid rgba(245, 158, 11, 0.4)',
                                color: '#fbbf24',
                                fontSize: '0.78rem',
                                fontWeight: 700,
                                outline: 'none'
                              }}
                            >
                              <option value="worst_drawdown">Deepest Drawdown Trough</option>
                              <option value="max_streak">Max Losing Streak Peak</option>
                              <option value="end_of_replay">End of Recorded Sequence</option>
                            </select>
                          </div>
                        </div>
                      </div>

                      {/* SIDE-BY-SIDE STRESS COMPARISON MATRIX */}
                      <div style={{ overflowX: 'auto' }}>
                        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.78rem', textAlign: 'left' }}>
                          <thead>
                            <tr style={{ borderBottom: isDark ? '1px solid rgba(255,255,255,0.1)' : '1px solid #cbd5e1', color: isDark ? '#94a3b8' : '#64748b' }}>
                              <th style={{ padding: '0.45rem 0.6rem' }}>Stress Metric</th>
                              <th style={{ padding: '0.45rem 0.6rem', textAlign: 'right' }}>Recorded Replay</th>
                              <th style={{ padding: '0.45rem 0.6rem', textAlign: 'right', color: '#fbbf24' }}>Hypothetical Stress Test</th>
                              <th style={{ padding: '0.45rem 0.6rem', textAlign: 'right' }}>Variance / Stress Impact</th>
                            </tr>
                          </thead>
                          <tbody>
                            <tr style={{ borderBottom: isDark ? '1px solid rgba(255,255,255,0.05)' : '1px solid #f1f5f9' }}>
                              <td style={{ padding: '0.45rem 0.6rem', fontWeight: 600 }}>Max Consecutive Loss Streak</td>
                              <td style={{ padding: '0.45rem 0.6rem', textAlign: 'right', color: dangerColor, fontWeight: 700 }}>
                                {simResults.maxLossStreak} Losses
                              </td>
                              <td style={{ padding: '0.45rem 0.6rem', textAlign: 'right', color: '#fbbf24', fontWeight: 800 }}>
                                {whatIfResults.sMaxLossStreak} Losses
                              </td>
                              <td style={{ padding: '0.45rem 0.6rem', textAlign: 'right', color: dangerColor, fontWeight: 700 }}>
                                +{whatIfResults.extraLosses} Consecutive Losses
                              </td>
                            </tr>

                            <tr style={{ borderBottom: isDark ? '1px solid rgba(255,255,255,0.05)' : '1px solid #f1f5f9' }}>
                              <td style={{ padding: '0.45rem 0.6rem', fontWeight: 600 }}>Minimum Starting Capital Needed</td>
                              <td style={{ padding: '0.45rem 0.6rem', textAlign: 'right', fontWeight: 700 }}>
                                {simResults.minCapitalNeeded.toLocaleString()} u
                              </td>
                              <td style={{ padding: '0.45rem 0.6rem', textAlign: 'right', color: '#fbbf24', fontWeight: 800 }}>
                                {whatIfResults.sMinCapitalNeeded.toLocaleString()} u
                              </td>
                              <td style={{ padding: '0.45rem 0.6rem', textAlign: 'right', color: whatIfResults.sMinCapitalNeeded > simResults.minCapitalNeeded ? dangerColor : successColor, fontWeight: 700 }}>
                                {whatIfResults.sMinCapitalNeeded > simResults.minCapitalNeeded ? '+' : ''}
                                {(whatIfResults.sMinCapitalNeeded - simResults.minCapitalNeeded).toLocaleString()} u required
                              </td>
                            </tr>

                            <tr style={{ borderBottom: isDark ? '1px solid rgba(255,255,255,0.05)' : '1px solid #f1f5f9' }}>
                              <td style={{ padding: '0.45rem 0.6rem', fontWeight: 600 }}>Max Drawdown Draw</td>
                              <td style={{ padding: '0.45rem 0.6rem', textAlign: 'right', color: dangerColor, fontWeight: 700 }}>
                                -{simResults.maxDrawdownUnits.toLocaleString()} u ({simResults.maxDrawdownPct.toFixed(1)}%)
                              </td>
                              <td style={{ padding: '0.45rem 0.6rem', textAlign: 'right', color: '#fbbf24', fontWeight: 800 }}>
                                -{whatIfResults.sMaxDrawdownUnits.toLocaleString()} u ({whatIfResults.sMaxDrawdownPct.toFixed(1)}%)
                              </td>
                              <td style={{ padding: '0.45rem 0.6rem', textAlign: 'right', color: dangerColor, fontWeight: 700 }}>
                                -{(whatIfResults.sMaxDrawdownUnits - simResults.maxDrawdownUnits).toLocaleString()} u extra drawdown
                              </td>
                            </tr>

                            <tr style={{ borderBottom: isDark ? '1px solid rgba(255,255,255,0.05)' : '1px solid #f1f5f9' }}>
                              <td style={{ padding: '0.45rem 0.6rem', fontWeight: 600 }}>Highest Single Bet Stake</td>
                              <td style={{ padding: '0.45rem 0.6rem', textAlign: 'right', fontWeight: 700 }}>
                                {simResults.maxSingleStake.toLocaleString()} u
                              </td>
                              <td style={{ padding: '0.45rem 0.6rem', textAlign: 'right', color: '#fbbf24', fontWeight: 800 }}>
                                {whatIfResults.sMaxSingleStake.toLocaleString()} u
                              </td>
                              <td style={{ padding: '0.45rem 0.6rem', textAlign: 'right', color: warningColor, fontWeight: 700 }}>
                                {(whatIfResults.sMaxSingleStake / Math.max(1, simResults.maxSingleStake)).toFixed(1)}x stake multiplier
                              </td>
                            </tr>

                            <tr>
                              <td style={{ padding: '0.45rem 0.6rem', fontWeight: 600 }}>Simulated Final Balance</td>
                              <td style={{ padding: '0.45rem 0.6rem', textAlign: 'right', color: simResults.netProfit >= 0 ? successColor : dangerColor, fontWeight: 700 }}>
                                {simResults.currentBalance.toLocaleString()} u
                              </td>
                              <td style={{ padding: '0.45rem 0.6rem', textAlign: 'right', color: whatIfResults.sNetProfit >= 0 ? successColor : dangerColor, fontWeight: 800 }}>
                                {whatIfResults.sBalance.toLocaleString()} u
                              </td>
                              <td style={{ padding: '0.45rem 0.6rem', textAlign: 'right', color: whatIfResults.sBalance >= simResults.currentBalance ? successColor : dangerColor, fontWeight: 700 }}>
                                {whatIfResults.sBalance >= simResults.currentBalance ? '+' : ''}
                                {(whatIfResults.sBalance - simResults.currentBalance).toLocaleString()} u delta
                              </td>
                            </tr>
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}

                  {/* ── RESPONSIVE SVG BANKROLL EQUITY CURVE ── */}
                  {simShowEquityChart && (
                    <div
                      style={{
                        background: isDark ? 'rgba(255, 255, 255, 0.02)' : '#f8fafc',
                        border: isDark ? '1px solid rgba(255, 255, 255, 0.08)' : '1px solid #e2e8f0',
                        borderRadius: '12px',
                        padding: '1rem',
                        marginBottom: '1.25rem'
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.6rem', flexWrap: 'wrap', gap: '0.5rem' }}>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                          <span style={{ fontWeight: 800, fontSize: '0.85rem' }}>📈 Bankroll Equity Trajectory</span>
                          <span style={{ fontSize: '0.72rem', color: isDark ? '#94a3b8' : '#64748b' }}>
                            (Start: {baseCapital.toLocaleString()} u • Peak: {simResults.peakBalance.toLocaleString()} u • End: {simResults.currentBalance.toLocaleString()} u)
                          </span>
                        </div>
                        <div style={{ fontSize: '0.74rem', display: 'flex', gap: '0.75rem', alignItems: 'center' }}>
                          <span style={{ color: successColor }}>● Replay Peak: {simResults.peakBalance.toLocaleString()} u</span>
                          <span style={{ color: dangerColor }}>● Max DD: -{simResults.maxDrawdownUnits.toLocaleString()} u</span>
                          {whatIfEnabled && (
                            <span style={{ color: '#fbbf24', fontWeight: 700 }}>
                              --- What-If Stress Trajectory
                            </span>
                          )}
                        </div>
                      </div>

                      <div style={{ width: '100%', height: '120px', position: 'relative' }}>
                        <svg width="100%" height="100%" viewBox={`0 0 ${svgW} ${svgH}`} preserveAspectRatio="none" style={{ overflow: 'visible' }}>
                          <defs>
                            <linearGradient id="equityGradient" x1="0" y1="0" x2="0" y2="1">
                              <stop offset="0%" stopColor={successColor} stopOpacity="0.3" />
                              <stop offset="100%" stopColor={successColor} stopOpacity="0.0" />
                            </linearGradient>
                          </defs>

                          {/* Starting Capital Baseline */}
                          <line
                            x1={svgPad}
                            y1={baselineY}
                            x2={svgW - svgPad}
                            y2={baselineY}
                            stroke={isDark ? 'rgba(255,255,255,0.2)' : 'rgba(0,0,0,0.15)'}
                            strokeDasharray="4 4"
                            strokeWidth="1.2"
                          />

                          {/* Real Equity Area */}
                          <polygon
                            points={`${svgPad},${svgH - svgPad} ${svgPointsStr} ${svgW - svgPad},${svgH - svgPad}`}
                            fill="url(#equityGradient)"
                          />

                          {/* Real Equity Line */}
                          <polyline
                            points={svgPointsStr}
                            fill="none"
                            stroke={simResults.netProfit >= 0 ? successColor : dangerColor}
                            strokeWidth="2.2"
                            strokeLinecap="round"
                            strokeLinejoin="round"
                          />

                          {/* What-If Stress Trajectory Overlay */}
                          {whatIfEnabled && stressSvgPointsStr && (
                            <polyline
                              points={stressSvgPointsStr}
                              fill="none"
                              stroke="#fbbf24"
                              strokeWidth="2"
                              strokeDasharray="5 3"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            />
                          )}
                        </svg>
                      </div>
                    </div>
                  )}

                  {/* ── STRATEGY PERFORMANCE BREAKDOWN TABLE ── */}
                  <div
                    style={{
                      background: isDark ? 'rgba(255, 255, 255, 0.02)' : '#ffffff',
                      border: isDark ? '1px solid rgba(255, 255, 255, 0.08)' : '1px solid #e2e8f0',
                      borderRadius: '12px',
                      padding: '1rem',
                      marginBottom: '1.25rem',
                      overflowX: 'auto'
                    }}
                  >
                    <div style={{ fontSize: '0.82rem', fontWeight: 800, marginBottom: '0.65rem' }}>
                      Strategy Performance Breakdown
                    </div>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.78rem', textAlign: 'left' }}>
                      <thead>
                        <tr style={{ borderBottom: isDark ? '1px solid rgba(255,255,255,0.1)' : '1px solid #cbd5e1', color: isDark ? '#94a3b8' : '#64748b' }}>
                          <th style={{ padding: '0.5rem' }}>Strategy Type</th>
                          <th style={{ padding: '0.5rem', textAlign: 'center' }}>Settled Bets</th>
                          <th style={{ padding: '0.5rem', textAlign: 'center' }}>Won / Lost / Void</th>
                          <th style={{ padding: '0.5rem', textAlign: 'center' }}>Win Rate</th>
                          <th style={{ padding: '0.5rem', textAlign: 'right' }}>Total Staked</th>
                          <th style={{ padding: '0.5rem', textAlign: 'right' }}>Net Profit/Loss</th>
                          <th style={{ padding: '0.5rem', textAlign: 'right' }}>ROI</th>
                          <th style={{ padding: '0.5rem', textAlign: 'right' }}>Sim. Balance</th>
                          <th style={{ padding: '0.5rem', textAlign: 'right' }}>Growth (ROC)</th>
                        </tr>
                      </thead>
                      <tbody>
                        {[
                          { name: '🛡️ Safest Pick', key: 'safest', color: successColor },
                          { name: '⚡ High Value Pick', key: 'high_value', color: warningColor },
                          { name: '🎯 AI Best Pick', key: 'ai_best_pick', color: accentColor },
                          { name: '⚽ Goals Engine', key: 'goals', color: '#06b6d4' },
                          { name: '📊 Filtered Portfolio Total', key: 'overall', color: isDark ? '#ffffff' : '#0f172a', bold: true }
                        ].map((row) => {
                          const data = simResults.strategyStats[row.key]
                          if (!data || (row.key !== 'overall' && data.played === 0)) return null
                          return (
                            <tr
                              key={row.key}
                              style={{
                                borderBottom: isDark ? '1px solid rgba(255,255,255,0.05)' : '1px solid #f1f5f9',
                                background: row.bold ? (isDark ? 'rgba(255,255,255,0.03)' : '#f8fafc') : 'transparent'
                              }}
                            >
                              <td style={{ padding: '0.55rem', fontWeight: row.bold ? 800 : 600, color: row.color }}>
                                {row.name}
                              </td>
                              <td style={{ padding: '0.55rem', textAlign: 'center', fontWeight: 600 }}>{data.played}</td>
                              <td style={{ padding: '0.55rem', textAlign: 'center' }}>
                                <span style={{ color: successColor }}>{data.won}</span> /{' '}
                                <span style={{ color: dangerColor }}>{data.lost}</span> /{' '}
                                <span style={{ opacity: 0.5 }}>{data.void}</span>
                              </td>
                              <td style={{ padding: '0.55rem', textAlign: 'center', fontWeight: 700, color: successColor }}>
                                {data.winRate}%
                              </td>
                              <td style={{ padding: '0.55rem', textAlign: 'right' }}>
                                {data.totalStaked.toLocaleString(undefined, { maximumFractionDigits: 0 })} u
                              </td>
                              <td
                                style={{
                                  padding: '0.55rem',
                                  textAlign: 'right',
                                  fontWeight: 800,
                                  color: data.profit >= 0 ? successColor : dangerColor
                                }}
                              >
                                {data.profit >= 0 ? '+' : ''}
                                {data.profit.toLocaleString(undefined, { maximumFractionDigits: 1 })} u
                              </td>
                              <td
                                style={{
                                  padding: '0.55rem',
                                  textAlign: 'right',
                                  fontWeight: 700,
                                  color: data.roi >= 0 ? successColor : dangerColor
                                }}
                              >
                                {data.roi >= 0 ? '+' : ''}
                                {data.roi}%
                              </td>
                              <td style={{ padding: '0.55rem', textAlign: 'right', fontWeight: 800 }}>
                                {data.balance.toLocaleString(undefined, { maximumFractionDigits: 0 })} u
                              </td>
                              <td
                                style={{
                                  padding: '0.55rem',
                                  textAlign: 'right',
                                  fontWeight: 800,
                                  color: data.roc >= 0 ? successColor : dangerColor
                                }}
                              >
                                {data.roc >= 0 ? '+' : ''}
                                {data.roc}%
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>

                  {/* ── CHRONOLOGICAL FILTERED BET LOG AUDIT ── */}
                  <div
                    style={{
                      background: isDark ? 'rgba(255, 255, 255, 0.02)' : '#ffffff',
                      border: isDark ? '1px solid rgba(255, 255, 255, 0.08)' : '1px solid #e2e8f0',
                      borderRadius: '12px',
                      padding: '1rem'
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '0.75rem', flexWrap: 'wrap', gap: '0.5rem' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <span style={{ fontWeight: 800, fontSize: '0.85rem' }}>
                          Chronological Filtered Bets Audit ({searchedBets.length} matches)
                        </span>
                        <button
                          onClick={() => setSimShowBetLog(!simShowBetLog)}
                          style={{
                            background: 'transparent',
                            border: 'none',
                            color: '#60a5fa',
                            fontSize: '0.74rem',
                            fontWeight: 700,
                            cursor: 'pointer'
                          }}
                        >
                          {simShowBetLog ? '▼ Collapse Table' : '▶ Expand Full Table'}
                        </button>
                      </div>

                      {simShowBetLog && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                          <div style={{ position: 'relative' }}>
                            <Search size={13} style={{ position: 'absolute', left: '8px', top: '50%', transform: 'translateY(-50%)', opacity: 0.5 }} />
                            <input
                              type="text"
                              placeholder="Search match, market, round..."
                              value={simBetLogSearch}
                              onChange={(e) => {
                                setSimBetLogSearch(e.target.value)
                                setSimBetLogPage(1)
                              }}
                              style={{
                                padding: '0.25rem 0.5rem 0.25rem 1.6rem',
                                borderRadius: '6px',
                                background: isDark ? '#0f172a' : '#ffffff',
                                border: isDark ? '1px solid rgba(255,255,255,0.15)' : '1px solid #cbd5e1',
                                color: isDark ? '#f8fafc' : '#0f172a',
                                fontSize: '0.75rem',
                                width: '200px'
                              }}
                            />
                          </div>
                          <span style={{ fontSize: '0.74rem', color: isDark ? '#94a3b8' : '#64748b' }}>
                            Page {currentPage} / {totalPages}
                          </span>
                        </div>
                      )}
                    </div>

                    {simShowBetLog && (
                      <div style={{ overflowX: 'auto' }}>
                        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.75rem', textAlign: 'left' }}>
                          <thead>
                            <tr style={{ borderBottom: isDark ? '1px solid rgba(255,255,255,0.1)' : '1px solid #cbd5e1', color: isDark ? '#94a3b8' : '#64748b' }}>
                              <th style={{ padding: '0.4rem' }}>#</th>
                              <th style={{ padding: '0.4rem' }}>Round</th>
                              <th style={{ padding: '0.4rem' }}>Matchup</th>
                              <th style={{ padding: '0.4rem' }}>Market</th>
                              <th style={{ padding: '0.4rem', textAlign: 'center' }}>Odds</th>
                              <th style={{ padding: '0.4rem', textAlign: 'center' }}>Conf</th>
                              <th style={{ padding: '0.4rem', textAlign: 'right' }}>Stake</th>
                              <th style={{ padding: '0.4rem', textAlign: 'center' }}>Score</th>
                              <th style={{ padding: '0.4rem', textAlign: 'center' }}>Status</th>
                              <th style={{ padding: '0.4rem', textAlign: 'right' }}>P/L</th>
                              <th style={{ padding: '0.4rem', textAlign: 'right' }}>Bankroll</th>
                            </tr>
                          </thead>
                          <tbody>
                            {pagedBets.map((b) => (
                              <tr key={b.id || b.betIdx} style={{ borderBottom: isDark ? '1px solid rgba(255,255,255,0.05)' : '1px solid #f1f5f9' }}>
                                <td style={{ padding: '0.4rem', opacity: 0.6 }}>{b.betIdx}</td>
                                <td style={{ padding: '0.4rem', fontWeight: 600 }}>R{b.round_number || '?'}</td>
                                <td style={{ padding: '0.4rem', fontWeight: 600 }}>
                                  {b.home_team} vs {b.away_team}
                                </td>
                                <td style={{ padding: '0.4rem', color: accentColor }}>{b.market}</td>
                                <td style={{ padding: '0.4rem', textAlign: 'center', fontWeight: 700 }}>@{b.odd}</td>
                                <td style={{ padding: '0.4rem', textAlign: 'center' }}>{b.probability}%</td>
                                <td style={{ padding: '0.4rem', textAlign: 'right', fontWeight: 700 }}>
                                  {b.stake.toLocaleString()} u
                                </td>
                                <td style={{ padding: '0.4rem', textAlign: 'center', opacity: 0.8 }}>{b.actual_score || '-'}</td>
                                <td style={{ padding: '0.4rem', textAlign: 'center' }}>
                                  <span
                                    style={{
                                      padding: '0.15rem 0.45rem',
                                      borderRadius: '4px',
                                      fontSize: '0.68rem',
                                      fontWeight: 800,
                                      background: b.status === 'won' ? 'rgba(34, 197, 94, 0.15)' : 'rgba(239, 68, 68, 0.15)',
                                      color: b.status === 'won' ? successColor : dangerColor
                                    }}
                                  >
                                    {b.status.toUpperCase()}
                                  </span>
                                </td>
                                <td
                                  style={{
                                    padding: '0.4rem',
                                    textAlign: 'right',
                                    fontWeight: 800,
                                    color: b.profit >= 0 ? successColor : dangerColor
                                  }}
                                >
                                  {b.profit >= 0 ? '+' : ''}
                                  {b.profit.toLocaleString()} u
                                </td>
                                <td style={{ padding: '0.4rem', textAlign: 'right', fontWeight: 700 }}>
                                  {b.balanceAfter.toLocaleString()} u
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>

                        {/* Pagination controls */}
                        {totalPages > 1 && (
                          <div style={{ display: 'flex', justifyContent: 'center', alignItems: 'center', gap: '0.5rem', marginTop: '0.75rem' }}>
                            <button
                              onClick={() => setSimBetLogPage((p) => Math.max(1, p - 1))}
                              disabled={currentPage === 1}
                              style={{
                                padding: '0.25rem 0.6rem',
                                borderRadius: '5px',
                                border: 'none',
                                background: isDark ? 'rgba(255,255,255,0.08)' : '#e2e8f0',
                                color: isDark ? '#ffffff' : '#0f172a',
                                cursor: currentPage === 1 ? 'not-allowed' : 'pointer',
                                opacity: currentPage === 1 ? 0.4 : 1
                              }}
                            >
                              <ChevronLeft size={13} />
                            </button>
                            <span style={{ fontSize: '0.75rem', fontWeight: 700 }}>
                              {currentPage} of {totalPages}
                            </span>
                            <button
                              onClick={() => setSimBetLogPage((p) => Math.min(totalPages, p + 1))}
                              disabled={currentPage === totalPages}
                              style={{
                                padding: '0.25rem 0.6rem',
                                borderRadius: '5px',
                                border: 'none',
                                background: isDark ? 'rgba(255,255,255,0.08)' : '#e2e8f0',
                                color: isDark ? '#ffffff' : '#0f172a',
                                cursor: currentPage === totalPages ? 'not-allowed' : 'pointer',
                                opacity: currentPage === totalPages ? 0.4 : 1
                              }}
                            >
                              <ChevronRight size={13} />
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* ══════════════════════════════════════════════════════════════════
                  VIEW 2: MARKET SUCCESS RADAR & ODDS DISTRIBUTION
                  ══════════════════════════════════════════════════════════════════ */}
              {(activeTab === 'markets' || activeTab === 'unified') && (
                <div style={{ marginBottom: activeTab === 'unified' ? '2.5rem' : '0' }}>
                  {/* Aggregate Summary Cards */}
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
                      gap: '0.75rem',
                      marginBottom: '1.25rem'
                    }}
                  >
                    <div
                      style={{
                        background: isDark ? 'rgba(255,255,255,0.03)' : '#f8fafc',
                        border: isDark ? '1px solid rgba(255,255,255,0.08)' : '1px solid #e2e8f0',
                        borderRadius: '12px',
                        padding: '1rem'
                      }}
                    >
                      <span style={{ fontSize: '0.72rem', color: isDark ? '#94a3b8' : '#64748b', fontWeight: 600 }}>
                        TOTAL MARKETS ANALYZED
                      </span>
                      <div style={{ fontSize: '1.4rem', fontWeight: 900, marginTop: '0.2rem' }}>
                        {Object.keys(data.markets || {}).length}
                      </div>
                      <span style={{ fontSize: '0.68rem', opacity: 0.7 }}>Virtual football betting categories</span>
                    </div>

                    <div
                      style={{
                        background: isDark ? 'rgba(255,255,255,0.03)' : '#f8fafc',
                        border: isDark ? '1px solid rgba(255,255,255,0.08)' : '1px solid #e2e8f0',
                        borderRadius: '12px',
                        padding: '1rem'
                      }}
                    >
                      <span style={{ fontSize: '0.72rem', color: isDark ? '#94a3b8' : '#64748b', fontWeight: 600 }}>
                        TOTAL GAMES SAMPLED
                      </span>
                      <div style={{ fontSize: '1.4rem', fontWeight: 900, color: successColor, marginTop: '0.2rem' }}>
                        {Object.values(data.markets || {}).reduce((sum, m) => sum + (m.total || 0), 0)}
                      </div>
                      <span style={{ fontSize: '0.68rem', opacity: 0.7 }}>Settled match data points</span>
                    </div>

                    <div
                      style={{
                        background: isDark ? 'rgba(255,255,255,0.03)' : '#f8fafc',
                        border: isDark ? '1px solid rgba(255,255,255,0.08)' : '1px solid #e2e8f0',
                        borderRadius: '12px',
                        padding: '1rem'
                      }}
                    >
                      <span style={{ fontSize: '0.72rem', color: isDark ? '#94a3b8' : '#64748b', fontWeight: 600 }}>
                        HIGH ODDS (≥3.3+) WINS
                      </span>
                      <div style={{ fontSize: '1.4rem', fontWeight: 900, color: '#f59e0b', marginTop: '0.2rem' }}>
                        {Object.values(data.markets || {}).reduce((sum, m) => sum + (m.odds_3_3_plus || 0), 0)}
                      </div>
                      <span style={{ fontSize: '0.68rem', opacity: 0.7 }}>Premium odds triggers</span>
                    </div>

                    <div
                      style={{
                        background: isDark ? 'rgba(255,255,255,0.03)' : '#f8fafc',
                        border: isDark ? '1px solid rgba(255,255,255,0.08)' : '1px solid #e2e8f0',
                        borderRadius: '12px',
                        padding: '1rem'
                      }}
                    >
                      <span style={{ fontSize: '0.72rem', color: isDark ? '#94a3b8' : '#64748b', fontWeight: 600 }}>
                        OVERALL LOSS STREAK (COMBINED)
                      </span>
                      <div style={{ fontSize: '1.4rem', fontWeight: 900, color: dangerColor, marginTop: '0.2rem' }}>
                        {data.overallPickSummary?.maxConsecutiveLosses ?? 'N/A'} Losses
                      </div>
                      <span style={{ fontSize: '0.68rem', opacity: 0.7 }}>Worst-case historical run</span>
                    </div>
                  </div>

                  {/* Search and Sort Toolbar */}
                  <div
                    style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      flexWrap: 'wrap',
                      gap: '0.75rem',
                      marginBottom: '1rem'
                    }}
                  >
                    <div style={{ position: 'relative', width: '280px' }}>
                      <Search size={14} style={{ position: 'absolute', left: '10px', top: '50%', transform: 'translateY(-50%)', opacity: 0.5 }} />
                      <input
                        type="text"
                        placeholder="Search markets (Over, GG, Away...)"
                        value={marketSearchTerm}
                        onChange={(e) => setMarketSearchTerm(e.target.value)}
                        style={{
                          width: '100%',
                          padding: '0.35rem 0.75rem 0.35rem 2rem',
                          borderRadius: '8px',
                          background: isDark ? '#0f172a' : '#ffffff',
                          border: isDark ? '1px solid rgba(255,255,255,0.15)' : '1px solid #cbd5e1',
                          color: isDark ? '#f8fafc' : '#0f172a',
                          fontSize: '0.8rem'
                        }}
                      />
                    </div>

                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <span style={{ fontSize: '0.74rem', color: isDark ? '#94a3b8' : '#64748b', fontWeight: 600 }}>SORT BY:</span>
                      <select
                        value={marketSortBy}
                        onChange={(e) => setMarketSortBy(e.target.value)}
                        style={{
                          padding: '0.35rem 0.65rem',
                          borderRadius: '8px',
                          background: isDark ? '#0f172a' : '#ffffff',
                          border: isDark ? '1px solid rgba(255,255,255,0.15)' : '1px solid #cbd5e1',
                          color: isDark ? '#f8fafc' : '#0f172a',
                          fontSize: '0.78rem',
                          fontWeight: 700
                        }}
                      >
                        <option value="percentage">Highest Success Rate</option>
                        <option value="total">Most Total Games</option>
                        <option value="market">Market Alphabetical</option>
                      </select>
                    </div>
                  </div>

                  {/* Modern Responsive Market Grid */}
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))',
                      gap: '0.9rem'
                    }}
                  >
                    {marketRadarList.map((m) => {
                      const successRate = m.percentage || 0
                      const isHigh = successRate >= 65
                      const isMed = successRate >= 50
                      const badgeBg = isHigh ? 'rgba(34, 197, 94, 0.15)' : isMed ? 'rgba(245, 158, 11, 0.15)' : 'rgba(239, 68, 68, 0.15)'
                      const badgeCol = isHigh ? successColor : isMed ? warningColor : dangerColor

                      return (
                        <div
                          key={m.market}
                          style={{
                            background: isDark ? 'rgba(255, 255, 255, 0.03)' : '#ffffff',
                            border: `1.5px solid ${isDark ? 'rgba(255, 255, 255, 0.08)' : '#e2e8f0'}`,
                            borderRadius: '12px',
                            padding: '1rem',
                            display: 'flex',
                            flexDirection: 'column',
                            gap: '0.75rem',
                            transition: 'transform 0.15s, border-color 0.15s',
                            boxShadow: isDark ? '0 4px 12px rgba(0,0,0,0.2)' : '0 2px 8px rgba(0,0,0,0.05)'
                          }}
                        >
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <h4 style={{ margin: 0, fontSize: '0.92rem', fontWeight: 800 }}>{m.market}</h4>
                            <span
                              style={{
                                background: badgeBg,
                                color: badgeCol,
                                padding: '0.2rem 0.55rem',
                                borderRadius: '20px',
                                fontSize: '0.68rem',
                                fontWeight: 800
                              }}
                            >
                              {isHigh ? '🔥 HIGH YIELD' : isMed ? '⚡ BALANCED' : '⚠️ VOLATILE'}
                            </span>
                          </div>

                          {/* Progress Meter */}
                          <div>
                            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '0.35rem', fontSize: '0.74rem' }}>
                              <span style={{ opacity: 0.7 }}>Success @≥3.3 Odds</span>
                              <strong style={{ color: badgeCol }}>{successRate.toFixed(1)}%</strong>
                            </div>
                            <div
                              style={{
                                width: '100%',
                                height: '6px',
                                borderRadius: '999px',
                                background: isDark ? 'rgba(255,255,255,0.08)' : '#e2e8f0',
                                overflow: 'hidden'
                              }}
                            >
                              <div
                                style={{
                                  width: `${Math.min(100, Math.max(0, successRate))}%`,
                                  height: '100%',
                                  background: badgeCol,
                                  borderRadius: '999px'
                                }}
                              />
                            </div>
                          </div>

                          {/* Quick Stats Grid */}
                          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '0.5rem', fontSize: '0.72rem' }}>
                            <div>
                              <span style={{ opacity: 0.6 }}>Total Games</span>
                              <div style={{ fontWeight: 800, marginTop: '0.1rem' }}>{m.total}</div>
                            </div>
                            <div>
                              <span style={{ opacity: 0.6 }}>High Odds Hits</span>
                              <div style={{ fontWeight: 800, color: successColor, marginTop: '0.1rem' }}>{m.odds_3_3_plus}</div>
                            </div>
                            <div>
                              <span style={{ opacity: 0.6 }}>Confidence</span>
                              <div style={{ fontWeight: 800, color: accentColor, marginTop: '0.1rem' }}>
                                {(m.confidence || 0).toFixed(0)}%
                              </div>
                            </div>
                          </div>

                          {/* Quick Simulate Button */}
                          <button
                            onClick={() => {
                              resetFilters()
                              setSimFilterMarket(m.market)
                              setActiveTab('simulation')
                            }}
                            style={{
                              padding: '0.35rem 0.65rem',
                              borderRadius: '7px',
                              background: isDark ? 'rgba(168,85,247,0.1)' : 'rgba(168,85,247,0.08)',
                              border: '1px solid rgba(168,85,247,0.25)',
                              color: accentColor,
                              fontSize: '0.72rem',
                              fontWeight: 700,
                              cursor: 'pointer',
                              display: 'flex',
                              alignItems: 'center',
                              justifyContent: 'center',
                              gap: '0.3rem',
                              marginTop: 'auto'
                            }}
                          >
                            <Activity size={12} />
                            Simulate Staking on This Market
                          </button>
                        </div>
                      )
                    })}
                  </div>
                </div>
              )}

              {/* ══════════════════════════════════════════════════════════════════
                  VIEW 3: HIGH-ODDS AI PREDICTIONS & SIGNALS
                  ══════════════════════════════════════════════════════════════════ */}
              {(activeTab === 'ai_picks' || activeTab === 'unified') && (
                <div>
                  {data.aiPickSummary && (
                    <div
                      style={{
                        background: isDark ? 'rgba(255,255,255,0.02)' : '#ffffff',
                        border: isDark ? '1px solid rgba(255,255,255,0.08)' : '1px solid #e2e8f0',
                        borderRadius: '14px',
                        padding: '1.25rem',
                        marginBottom: '1.5rem'
                      }}
                    >
                      <h4 style={{ margin: '0 0 1rem 0', fontSize: '1rem', fontWeight: 800, display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                        <Sparkles size={18} color="#fbbf24" />
                        AI High-Risk / High-Odds Model Track Record
                      </h4>

                      <div
                        style={{
                          display: 'grid',
                          gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))',
                          gap: '0.75rem',
                          marginBottom: '1.25rem'
                        }}
                      >
                        <div style={{ background: isDark ? 'rgba(255,255,255,0.03)' : '#f8fafc', padding: '0.75rem', borderRadius: '10px' }}>
                          <span style={{ fontSize: '0.68rem', opacity: 0.7 }}>TOTAL AI PICKS</span>
                          <div style={{ fontSize: '1.2rem', fontWeight: 800, marginTop: '0.2rem' }}>
                            {data.aiPickSummary.totalPicks}
                          </div>
                        </div>

                        <div style={{ background: isDark ? 'rgba(255,255,255,0.03)' : '#f8fafc', padding: '0.75rem', borderRadius: '10px' }}>
                          <span style={{ fontSize: '0.68rem', opacity: 0.7 }}>PENDING SIGNALS</span>
                          <div style={{ fontSize: '1.2rem', fontWeight: 800, color: successColor, marginTop: '0.2rem' }}>
                            {data.aiPickSummary.highOddsPending}
                          </div>
                        </div>

                        <div style={{ background: isDark ? 'rgba(255,255,255,0.03)' : '#f8fafc', padding: '0.75rem', borderRadius: '10px' }}>
                          <span style={{ fontSize: '0.68rem', opacity: 0.7 }}>AVG IMPLIED ODDS</span>
                          <div style={{ fontSize: '1.2rem', fontWeight: 800, color: accentColor, marginTop: '0.2rem' }}>
                            @{data.aiPickSummary.avgImpliedOdd}
                          </div>
                        </div>

                        <div style={{ background: isDark ? 'rgba(255,255,255,0.03)' : '#f8fafc', padding: '0.75rem', borderRadius: '10px' }}>
                          <span style={{ fontSize: '0.68rem', opacity: 0.7 }}>AVG PROBABILITY</span>
                          <div style={{ fontSize: '1.2rem', fontWeight: 800, marginTop: '0.2rem' }}>
                            {data.aiPickSummary.avgProbability}%
                          </div>
                        </div>

                        <div style={{ background: isDark ? 'rgba(255,255,255,0.03)' : '#f8fafc', padding: '0.75rem', borderRadius: '10px' }}>
                          <span style={{ fontSize: '0.68rem', opacity: 0.7 }}>AI WIN RATE</span>
                          <div style={{ fontSize: '1.2rem', fontWeight: 800, color: successColor, marginTop: '0.2rem' }}>
                            {data.aiPickSummary.winRate}%
                          </div>
                        </div>
                      </div>

                      {/* AI Worst-Case Loss Streak Alert */}
                      {data.aiPickSummary.maxConsecutiveLosses != null && (
                        <div
                          style={{
                            background: 'rgba(239, 68, 68, 0.08)',
                            border: '1.5px solid rgba(239, 68, 68, 0.3)',
                            borderRadius: '10px',
                            padding: '0.9rem 1.1rem',
                            display: 'flex',
                            alignItems: 'center',
                            gap: '1rem',
                            flexWrap: 'wrap'
                          }}
                        >
                          <div
                            style={{
                              background: 'rgba(239, 68, 68, 0.15)',
                              border: '1.5px solid rgba(239, 68, 68, 0.35)',
                              borderRadius: '10px',
                              padding: '0.5rem 0.85rem',
                              textAlign: 'center',
                              minWidth: '65px'
                            }}
                          >
                            <span style={{ fontSize: '1.7rem', fontWeight: 900, color: '#ef4444', lineHeight: 1 }}>
                              {data.aiPickSummary.maxConsecutiveLosses}
                            </span>
                            <span style={{ fontSize: '0.55rem', fontWeight: 700, color: '#f87171', display: 'block', textTransform: 'uppercase' }}>
                              in a row
                            </span>
                          </div>

                          <div style={{ flex: 1, minWidth: '220px' }}>
                            <div style={{ fontSize: '0.86rem', fontWeight: 800, color: '#ef4444', marginBottom: '0.2rem' }}>
                              Worst-Case Losing Streak (AI Best Pick Only)
                            </div>
                            <div style={{ fontSize: '0.74rem', opacity: 0.8, lineHeight: 1.4 }}>
                              The longest recorded loss streak for High-Odds AI Best Picks is{' '}
                              <strong style={{ color: '#ef4444' }}>{data.aiPickSummary.maxConsecutiveLosses} losses in a row</strong>.
                              Always ensure your bankroll accommodates this historical benchmark under uncapped Martingale escalation.
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Top Pending AI High-Odds Predictions */}
                  {data.topAIPredictions?.length > 0 && (
                    <div>
                      <h4 style={{ margin: '0 0 0.75rem 0', fontSize: '0.92rem', fontWeight: 800, color: isDark ? '#e2e8f0' : '#1e293b' }}>
                        Top Pending High-Odds AI Signals
                      </h4>
                      <div style={{ display: 'grid', gap: '0.65rem' }}>
                        {data.topAIPredictions.map((pick, index) => (
                          <div
                            key={`${pick.home_team}-${pick.away_team}-${index}`}
                            style={{
                              background: isDark ? 'rgba(255, 255, 255, 0.03)' : '#ffffff',
                              border: isDark ? '1px solid rgba(255, 255, 255, 0.08)' : '1px solid #e2e8f0',
                              borderRadius: '10px',
                              padding: '0.85rem 1.1rem',
                              display: 'flex',
                              justifyContent: 'space-between',
                              alignItems: 'center',
                              gap: '1rem'
                            }}
                          >
                            <div>
                              <div style={{ fontSize: '0.92rem', fontWeight: 800 }}>
                                {pick.home_team} vs {pick.away_team}
                              </div>
                              <div style={{ fontSize: '0.74rem', opacity: 0.6, marginTop: '0.2rem' }}>
                                {pick.market} • {pick.pick_type ? pick.pick_type.replace('_', ' ').toUpperCase() : 'AI PICK'} • Round {pick.round_number || '?'}
                              </div>
                            </div>

                            <div style={{ textAlign: 'right' }}>
                              <div style={{ fontSize: '1.05rem', fontWeight: 900, color: successColor }}>
                                @{pick.implied_odd}
                              </div>
                              <div style={{ fontSize: '0.72rem', color: accentColor, fontWeight: 700 }}>
                                {pick.probability}% Conf.
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>

        {/* ── MODAL FOOTER ── */}
        <div
          style={{
            padding: '0.85rem 1.5rem',
            borderTop: isDark ? '1px solid rgba(255, 255, 255, 0.08)' : '1px solid #e5e7eb',
            background: isDark ? 'rgba(255, 255, 255, 0.02)' : '#f9fafb',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center'
          }}
        >
          <div style={{ fontSize: '0.72rem', color: isDark ? '#94a3b8' : '#64748b' }}>
            Generated: {data?.generatedAt ? new Date(data.generatedAt).toLocaleString() : 'N/A'} • Live Staking Replay
          </div>
          <button
            onClick={onClose}
            style={{
              padding: '0.45rem 1.25rem',
              borderRadius: '8px',
              background: isDark ? 'rgba(255,255,255,0.08)' : '#e2e8f0',
              border: 'none',
              color: isDark ? '#f8fafc' : '#0f172a',
              fontSize: '0.82rem',
              fontWeight: 700,
              cursor: 'pointer'
            }}
          >
            Close Dashboard
          </button>
        </div>
      </div>
    </div>
  )
}

export default MarketAnalyticsModal
