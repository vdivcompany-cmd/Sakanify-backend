const start = Date.now();
function t(label) { console.log(label, Date.now() - start, 'ms'); }
t('start');
const app = require('./src/app.entry.js');
t('app.entry.js loaded OK, type: ' + typeof app);
