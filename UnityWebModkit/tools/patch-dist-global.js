const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const distDir = path.resolve(__dirname, "..", "dist");
const files = fs
  .readdirSync(distDir)
  .filter((file) => /^unity-web-modkit\.[a-f0-9]+\.js$/.test(file));

if (files.length !== 1) {
  throw new Error(`Expected one UnityWebModkit dist file, found ${files.length}`);
}

const filePath = path.join(distDir, files[0]);
const source = fs.readFileSync(filePath, "utf8");
const needle = "window.UnityWebModkit=n";
const replacement = [
  '(()=>{const t=typeof unsafeWindow!="undefined"?unsafeWindow:void 0;',
  'if(t)t.UnityWebModkit=n;',
  'if(typeof window!="undefined")window.UnityWebModkit=n;',
  'if(typeof globalThis!="undefined")globalThis.UnityWebModkit=n})()',
].join("");

if (!source.includes(needle)) {
  throw new Error(`Unable to locate ${needle} in ${files[0]}`);
}

const patched = source.replace(needle, replacement);
fs.writeFileSync(filePath, patched);

const hash = crypto.createHash("sha1").update(patched).digest("hex").slice(0, 20);
const finalName = `unity-web-modkit.${hash}.js`;
const finalPath = path.join(distDir, finalName);
if (finalPath !== filePath) {
  fs.renameSync(filePath, finalPath);
}
