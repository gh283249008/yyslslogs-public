// Local YYSLS adaptation. Original Kagerou GPL-3.0-or-later notices retained.
// Only observed columns are enabled; FFXIV hit/crit/uptime semantics do not transfer.
CONFIG_DEFAULT.tabs = [{id:0,label:'伤害',width:1,sort:'deal.total',col:['i.rank','i.name','deal.total','deal.per_second','yysls.rdps']},{id:1,label:'真气',width:1,sort:'yysls.qiTotal',col:['i.rank','i.name','yysls.qiTotal','yysls.qiDps']}]
CONFIG_DEFAULT.filter.jobless=false
CONFIG_DEFAULT.footer.rank=false
CONFIG_DEFAULT.format.merge_pet=false
CONFIG_DEFAULT.format.thousands_separator=','
CONFIG_DEFAULT.style['gauge-height']='100%'
CONFIG_DEFAULT.color['gauge-default']='#237c8b'
CONFIG_DEFAULT.color['gauge-opacity']='0.4'
CONFIG_DEFAULT.colwidth['_i-name']=7
CONFIG_DEFAULT.colwidth['_deal-total']=6
CONFIG_DEFAULT.colwidth['_deal-per_second']=5
CONFIG_DEFAULT.colwidth['_yysls-rdps']=4
CONFIG_DEFAULT.colwidth['_yysls-given']=5
CONFIG_DEFAULT.colwidth['_yysls-taken']=5
CONFIG_DEFAULT.colwidth['_yysls-qiTotal']=7
CONFIG_DEFAULT.colwidth['_yysls-qiDps']=6
COLUMN_INDEX.yysls={rdps:'yyslsRdps',given:'yyslsGiven',taken:'yyslsTaken',qiTotal:'yyslsQiDamage',qiDps:'yyslsQiDps'}
for (const key of Object.keys(COLUMN_INDEX.yysls)) {
  const value=COLUMN_INDEX.yysls[key]
  COLUMN_INDEX.yysls[key]={v:value,f:(n,conf)=>Number.isFinite(n)?formatDps(n,conf.format,key==='qiTotal'?'damage':'dps',key==='qiTotal'):'—'}
}
for (const key of ['yysls.qiTotal','yysls.qiDps']) if (!COLUMN_SORTABLE.includes(key)) COLUMN_SORTABLE.push(key)
