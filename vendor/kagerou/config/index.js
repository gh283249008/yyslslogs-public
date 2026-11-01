import '../share/lib/util.js'
import '../share/lib/locale.js'
import '../share/lib/config.js'
import '../share/lib/yysls-defaults.js'
import './lib/dialog.js'
import './lib/ui.js'
import './lib/tabconfig.js'
import './lib/import-export.js'

window.config = new Config()

config.load()
config.setResizeFactor()

window.locale = new Locale(window.config.get('lang'))

document.addEventListener('DOMContentLoaded', (_) => {
  window.tabconfig = new Tabconfig()
  setTimeout((_) => window.locale.localizeAll(), 500)
})
