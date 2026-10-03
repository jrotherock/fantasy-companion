/**
 * The app's PNG icons, rendered from src/ui/public/icon.svg — the one source
 * for the browser tab, the Home Screen and the installed app.
 *
 *   npx tsx scripts/icons.ts
 *
 * iOS ignores an SVG touch icon and Android wants PNGs in the manifest, so the
 * SVG alone is not enough.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { Resvg } from '@resvg/resvg-js'

const dir = 'src/ui/public'
const svg = readFileSync(`${dir}/icon.svg`, 'utf8')
for (const [file, size] of [['icon-192.png', 192], ['icon-512.png', 512], ['apple-touch-icon.png', 180]] as const) {
  const png = new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng()
  writeFileSync(`${dir}/${file}`, png)
  console.log(`${file} ${size}px ${png.length} bytes`)
}
