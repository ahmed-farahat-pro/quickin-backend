// Lets a script import src/lib/local/*.ts despite their extension-less relative
// imports (`from './pool'`), which Node's ESM resolver rejects. Node strips the
// types itself; only resolution needs help. Used by the _verify-* scripts.
//   node --import ./scripts/_ts-resolve-hook.mjs scripts/_verify-ops-port.mjs
import { register } from 'node:module'
import { pathToFileURL } from 'node:url'
register('./_ts-resolve-impl.mjs', pathToFileURL('./scripts/'))
