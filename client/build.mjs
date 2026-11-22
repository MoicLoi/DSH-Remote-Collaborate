// Wrap client/source.js into the DSH client module envelope.
//
// The host serves this file from /plugins/... and the browser module table calls
// `factory(require)`; there is no bundler because the only external is `react`,
// which the module table provides.
import { readFile, writeFile } from 'node:fs/promises'

const root = new URL('.', import.meta.url)
const source = await readFile(new URL('source.js', root), 'utf8')
const id = 'dsh-collab'

const wrapped = `window.__ModuleLoader__.load({
  id: ${JSON.stringify(id)},
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
${source}
    return module.exports;
  }
});
`

await writeFile(new URL('client.js', root), wrapped, 'utf8')
console.log(`dsh-collab: wrote client/client.js (${wrapped.length} bytes)`)
