import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pasta = path.dirname(fileURLToPath(import.meta.url));
const suites = ["agenda.mjs", "conexao.mjs", "contas.mjs", "backend.cjs", "contrato.cjs", "oauth.cjs", "push.cjs"];
let falhas = 0;

for (const suite of suites) {
  console.log(`\n${suite}`);
  const argumentos = suite.endsWith(".mjs") ? ["--experimental-vm-modules"] : [];
  const resultado = spawnSync(process.execPath, [...argumentos, path.join(pasta, suite)], { stdio: "inherit" });
  if (resultado.error || resultado.status !== 0) {
    falhas++;
    if (resultado.error) console.error(resultado.error.message);
  }
}

console.log(`\n${suites.length - falhas}/${suites.length} suítes passaram.`);
process.exitCode = falhas ? 1 : 0;
