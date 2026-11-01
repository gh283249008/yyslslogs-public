import '../share/lib/util.js'
import '../share/lib/config.js'
import '../share/lib/yysls-defaults.js'
import '../share/lib/ws-abstract.js'
import '../share/lib/locale.js'
import './lib/render.js'
import './lib/listen.js'
import './lib/ui.js'
import './yysls.js'

// temporal ACTWebSocket fix: Newer OverlayProc doesn't allow 'downgrade'
// security, from https to unsecured websocket, and GitHub pages forces HTTPS.
// I know this sucks.
if (
  window.layer &&
  layer.type === 'ws' &&
  location.host === 'hibiyasleep.github.io'
) {
  location.href = 'http://kagerou.hibiya.moe/overlay' + location.search
}

// config
window.config = new Config()

config.load()
config.migrate()
config.setResizeFactor()
config.attachOverlayStyle('overlay')

window.hist = new History()

window.addEventListener('load', (e) => {
  // locale
  window.l = new Locale(window.config.get('lang'), (e) => {
    window.l.localizeAll()
    window.renderer = new Renderer(window.config.get())
    window.renderer.updateHeader()

    window.tabdisplay = new TabDisplay()
    window.historyUI = new HistoryUI()

    window.tabdisplay.render()
    $('.history', 0).addEventListener('click', (e) => {
      window.historyUI.updateList()
    })

    // listen
    layer.connect()
    layer.on('data', (d) => {
      window.hist.push(d)
      if (window.renderer) {
        window.renderer.update()
      }
    })
    // layer.on('status')
    // layer.emit('restyle')
  })

  $map('svg', (_) => {
    _.style.width = parseInt(_.getAttribute('width')) / 16 + 'rem'
    _.style.height = parseInt(_.getAttribute('height')) / 16 + 'rem'
  })

  $('.splash', 0).classList.add('hidden')
})
