// Local, sandboxed host bridge. Never contacts the game or an external server.
import './yysls.css'
window.__yyslsErrors=[]
window.addEventListener('error',e=>window.__yyslsErrors.push(e.message))
window.addEventListener('load',()=>{
  const panel=document.createElement('section');panel.id='yysls-panel'
  panel.innerHTML='<div class="yysls-drag"><b>燕云 Logs</b><span id="yysls-mode">等待采集器</span><span class="host-buttons"><button data-host="replay">样本回放</button><button data-host="live">实时</button><button data-host="lock" title="Ctrl+Shift+F8">锁定</button><button data-host="hide" title="Ctrl+Shift+F9">隐藏</button><button data-host="quit">×</button></span></div><div id="yysls-status">尚未接收到数据</div><div class="yysls-notice">rDPS：缺少已验证的增益归因 · 队友覆盖待验证</div>'
  document.body.prepend(panel)
  panel.addEventListener('click',e=>{const a=e.target.closest('[data-host]')?.dataset.host;if(a)window.yysls?.command(a)})
  const label=document.querySelector('.footer-rdps > small');if(label)label.textContent='已观测 DPS'
  document.querySelector('#rdps').textContent='—'
  const patchnote=document.querySelector('#patchnote');if(patchnote)patchnote.textContent='等待燕云战斗数据。Ctrl+Shift+F8 切换鼠标穿透，Ctrl+Shift+F9 显示或隐藏。'
  // Preserve user styling/configuration, enforce supported column semantics.
  const timer=setInterval(()=>{
    if(!window.renderer||!window.l?.loaded)return
    clearInterval(timer)
    window.l.L[window.l.current].col.yysls={rdps:['rDPS','原始 DPS − TAKEN + GIVEN'],given:['GIVEN','给队友带来的实际增伤 DPS'],taken:['TAKEN','从队友获得的实际增伤 DPS（不是承伤）'],qiTotal:['真气输出','独立真气伤害，不含气血、治疗和承伤'],qiDps:['真气 DPS','真气输出 ÷ 本场战斗时长']}
    window.config.set('tabs',CONFIG_DEFAULT.tabs)
    window.config.set('filter.jobless',false)
    window.config.set('format.merge_pet',false)
    window.config.set('footer.rank',false)
    window.renderer.updateConfig(window.config.get());window.renderer.updateHeader();window.tabdisplay.render()
    if(!window.yysls){document.querySelector('#yysls-status').textContent='请通过本地燕云悬浮窗启动器打开';return}
    let previousMode=null
    window.yysls.subscribe(s=>{
      if(previousMode!==s.mode){
        previousMode=s.mode;window.hist=new History();window.renderer.currentHistory=false;window.renderer.standby=true
        document.body.classList.add('standby');document.querySelector('#table').textContent=''
        document.querySelector('#rdps').textContent='—';document.querySelector('#history-time').textContent='等待数据';document.querySelector('#history-mob').textContent=''
      }
      const replay=s.mode==='replay'||s.snapshot?.source?.mode==='replay'
      document.querySelector('#yysls-mode').textContent=replay?'真实样本回放 · 非实时':'实时采集'
      const attribution=s.attribution||s.encounter?.attributionValidation
      const rdpsText=attribution?.status==='estimated'?'rDPS：简化估算 · 已采命中':attribution?.status==='available'?'rDPS：已验证归因':attribution?.status==='synthetic'?'rDPS：模拟验证 · 非实战':'rDPS：归因待验证'
      const qiText=s.encounter?.qi?.status==='validated-counter'?'真气：已观测输出':'真气：数据待验证'
      document.querySelector('.yysls-notice').textContent=rdpsText+' · '+qiText+(s.labelsFromScreenshot?' · 名字依截图匹配':'')
      document.querySelector('.yysls-notice').title=[...(attribution?.limitations||[]),...(attribution?.reasons||[]),s.resourceError||s.encounter?.qi?.reason||''].filter(Boolean).join('\n')
      panel.classList.toggle('replay',replay)
      const snap=s.snapshot,enc=s.encounter
      let status=s.inputError||'等待服务器统计'
      if(snap){
        const bad=s.transportStale||snap.health?.session==='invalid'||snap.health?.gap||['invalid','stopped'].includes(snap.health?.status)
        const estimated=enc?.durationBasis==='local-statistic-start-estimate'
        const stateTimed=enc?.durationBasis==='server-battle-state-received'
        status=bad?'采集已中断，保留上次结果':enc?(enc.finalized?'战斗已结算 · 使用服务器时长':enc.clockEnded?'战斗已结束 · 等待结算校准':stateTimed?'实时 DPS · 按服务器开战状态计时':estimated?'实时估算 DPS · 按首笔伤害计时':'累计伤害更新中 · 缺少开战时间'):'已连接 · 等待战斗'
        if(enc?.retained)status='战斗已结束 · '+(enc.finalized?'保留结算结果':stateTimed?'保留接收时间计时结果':'保留估算结果')
        if(!bad&&snap.health?.stale&&enc&&!enc.finalized&&!enc.retained&&!enc.clockEnded)status='等待统计更新 · 计时已暂停'
        if(bad)status='数据中断 / 会话失效，保留上次结果'
        if(snap.health?.status==='stopped')status='采集已停止 · 保留结果'
        status+=` · 已观测 ${enc?.actors.length||snap.actors?.length||0} 人`
        if(snap.health?.status==='waiting'&&!enc&&!bad)status='采集连接正常 · 副本外等待统计'
        if(snap.coverage?.knownAcquisitionGaps?.length)status+=' · 本轮逐击有采集缺口'
      }
      document.querySelector('#yysls-status').textContent=status
      if(!enc){
        const serviceMessage=s.service?.message
        document.querySelector('#history-time').textContent=serviceMessage||status
        document.querySelector('#history-mob').textContent=''
      }
      const nav=document.querySelector('nav');if(nav)nav.title=(replay?'历史回放 · ':'')+(s.service?.detail||status)+'\n'+rdpsText+' · '+qiText
      document.querySelector('[data-host="lock"]').textContent=s.locked?'已穿透':'锁定'
      if(s.data){window.hist.push(s.data);window.renderer.update()}
      const foot=document.querySelector('.footer-rdps > small');if(foot)foot.textContent=replay?'回放 · 估算':attribution?.updating?'DPS · 归因更新中':attribution?.retained?'已保留 · 估算':window.renderer.current==='1'?'真气 DPS':attribution?.status==='estimated'?'DPS · 归因估算':'DPS'
    })
  },50)
})
