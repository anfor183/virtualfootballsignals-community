import React, { useState } from 'react'

export default function StrategyEvidence({ evidence }) {
  const [mode, setMode] = useState('martingale_2_0')
  const [lane, setLane] = useState('qualified')
  if (!evidence) return null
  const money = n => n == null ? '—' : `₦${Number(n).toLocaleString('en-NG', { maximumFractionDigits: 2 })}`
  const cell = stat => !stat?.n ? <span>No settled selections</span> : <>
    <strong style={{ color: stat.netProfit > 0 ? '#10b981' : '#ef4444' }}>{money(stat.netProfit)}</strong>
    <div>{stat.n} bets · {stat.winRate}% wins · {stat.roi}% ROI</div>
    <div>Max drawdown {money(stat.maxDrawdown)}</div>
    {stat.unableToFundNextStake && <div style={{color:'#ef4444'}}>Stopped: next stake could not be funded</div>}
  </>
  const names = { safest: 'Safest', high_chance: 'High Chance', ai_best: 'AI Best', goals:'Goals Engine' }
  const qualification=(eng,key)=>eng?.strategyQualification?.[key]?.passed===true
  return <section style={{padding:'1.5rem',marginBottom:'2rem',border:'1px solid var(--border-color)',borderRadius:12,background:'var(--panel-bg)'}}>
    <h3 style={{marginTop:0}}>Strategy evidence — backtest and forward test</h3>
    <p>Starting bankroll <strong>{money(evidence.bankroll)}</strong> per engine · base stake <strong>{money(evidence.baseStake)}</strong> · seven bets per cycle, then reset.</p>
    <p>2x and 3x qualify independently. Either can pass, but only that staking mode is qualified. Each requires at least 100 settled picks across five WAT days, positive historical and forward results, positive uncertainty bounds and no unfunded stakes.</p>
    <label>Staking comparison: <select aria-label="Evidence staking comparison" value={mode} onChange={e=>setMode(e.target.value)}>
      <option value="fixed">Flat stake</option><option value="martingale_1_5">Martingale 1.5x · cap 7</option>
      <option value="martingale_2_0">Martingale 2x · cap 7</option><option value="martingale_3_0">Martingale 3x · cap 7</option>
    </select></label>{' '}
    <label>Selections: <select aria-label="Evidence selection source" value={lane} onChange={e=>setLane(e.target.value)}>
      <option value="qualified">Qualified paper policies</option><option value="shadow">Experimental model selections</option>
    </select></label>
    <p style={{fontSize:'.8rem',color:'var(--text-secondary)'}}>Qualified paper policies are frozen model decisions, separate from approved betting signals. Experimental selections include ideas rejected by the qualification rules.</p>
    {evidence.trackingRun && <p>New forward period started {new Date(evidence.trackingRun.started_at).toLocaleString('en-NG',{timeZone:'Africa/Lagos'})} WAT. Earlier results remain archived.</p>}
    <div style={{overflowX:'auto'}}><table style={{width:'100%',textAlign:'left',fontSize:'.85rem',borderCollapse:'collapse'}}>
      <thead><tr><th>Engine</th><th>Untouched historical audit</th><th>New forward records · current version</th><th>2x qualification</th><th>3x qualification</th></tr></thead>
      <tbody>{Object.entries(names).map(([key,name])=>{
        const eng=evidence.engines?.[key]
        return <tr key={key} style={{borderTop:'1px solid var(--border-color)'}}>
          <td style={{padding:12,fontWeight:700}}>{name}{eng?.qualificationNote&&<p style={{fontWeight:400}}>{eng.qualificationNote}</p>}</td>
          <td style={{padding:12}}>{eng?.historicalAuditAvailable===false?'Historical audit not yet available':cell(eng?.historical?.[lane]?.[mode])}</td>
          <td style={{padding:12}}>{cell(eng?.forward?.[lane]?.[mode])}<div>{eng?.forward?.pending || 0} model observations awaiting results</div></td>
          {['martingale_2_0','martingale_3_0'].map(key=><td key={key} style={{padding:12,color:qualification(eng,key)?'#10b981':'#f59e0b'}}>{qualification(eng,key)?'Evidence criteria passed':'Not established'}</td>)}
        </tr>
      })}</tbody>
    </table></div>
    <p style={{fontSize:'.8rem',color:'var(--text-secondary)'}}>Captured odds and settled results only. Simulations assume each result is settled before the next stake; execution timing and slippage are not verified. No credit or replenishment is assumed. A high win rate or a profitable replay does not establish future profitability.</p>
    {evidence.policyReplay && <details>
      <summary>Historical reference replay</summary>
      <p>{evidence.policyReplay.sourceRows?.toLocaleString()} archived fixtures. This uses archived raw forecasts and fixed rules; it is separate from the new model’s untouched audit and genuine forward records.</p>
      <div style={{overflowX:'auto'}}><table style={{width:'100%',textAlign:'left',fontSize:'.85rem'}}><thead><tr><th>Rule</th><th>Flat stake</th><th>2x · cap 7</th></tr></thead>
        <tbody>{[['all','All fixtures'],['midnightPause','Daytime only'],['overnight','Overnight only'],['disciplined','Positive EV filter'],['combined','Both filters']].map(([key,label])=><tr key={key}>
          <td>{label}</td><td>{cell(evidence.policyReplay[key]?.fixed)}</td><td>{cell(evidence.policyReplay[key]?.martingale_2_0)}</td>
        </tr>)}</tbody>
      </table></div>
      <p>Differences between day and night do not prove a causal advantage. Archived forecasts have no immutable capture timestamp, so this reference is not forward-test evidence. The rules remain under evaluation.</p>
    </details>}
  </section>
}
