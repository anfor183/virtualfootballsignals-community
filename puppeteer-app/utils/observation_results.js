'use strict';
// Results may move out of the rolling live table. Resolve only an exact fixture;
// a repeated pairing, adjacent kickoff, or conflicting score cannot settle it.
function lookup(db) {
    const tables=['live_predictions','historical_market_predictions'].filter(name=>db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
    const statements=tables.map(name=>db.prepare(`SELECT actual_score,actual_ht_score FROM ${name}
        WHERE kickoff_timestamp=? AND season_name=? AND round_number=? AND home_team=? AND away_team=? AND actual_score IS NOT NULL`));
    return pick=>{
        const rows=statements.flatMap(stmt=>stmt.all(pick.kickoff_timestamp,pick.season_name,pick.round_number,pick.home_team,pick.away_team));
        const valid=s=>/^\d+:\d+$/.test(s||'');
        const scores=[...new Set(rows.map(r=>r.actual_score).filter(valid))];
        const halves=[...new Set(rows.map(r=>r.actual_ht_score).filter(valid))];
        if(scores.length!==1 || halves.length>1 || pick.market.startsWith('HT/FT ') && halves.length!==1)return null;
        return {actual_score:scores[0],actual_ht_score:halves[0]||null};
    };
}
module.exports={lookup};
