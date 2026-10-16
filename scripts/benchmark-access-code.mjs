import { availableParallelism, cpus } from "node:os";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  alias: {
    "@": fileURLToPath(new URL("../src", import.meta.url)),
    // Let Node honor --conditions=react-server before jiti resolves this marker.
    "server-only": fileURLToPath(import.meta.resolve("server-only")),
  },
});
const { hashAccessCode, verifyAccessCode } = await jiti.import("../src/lib/security/access-code.ts");
const syntheticCode = "public-synthetic-benchmark-code-v1";
const encoded = await hashAccessCode(syntheticCode);

async function measure(operation) {
  const samples = [];
  for (let i = 0; i < 5; i += 1) {
    const start = performance.now();
    await operation();
    samples.push(performance.now() - start);
  }
  const ordered = [...samples].sort((a, b) => a - b);
  return {
    samplesMs: samples.map((sample) => Number(sample.toFixed(2))),
    medianMs: Number(ordered[Math.floor(ordered.length / 2)].toFixed(2)),
    maxMs: Number(ordered.at(-1).toFixed(2)),
  };
}

const hashing = await measure(() => hashAccessCode(syntheticCode));
const verification = await measure(async () => {
  if (!await verifyAccessCode(syntheticCode, encoded)) throw new Error("Synthetic verification failed.");
});

console.log(JSON.stringify({
  node: process.version,
  platform: `${process.platform}/${process.arch}`,
  cpu: cpus()[0]?.model,
  availableParallelism: availableParallelism(),
  parameters: { N: 32_768, r: 8, p: 3, saltBytes: 32, keyBytes: 64, maxmemMiB: 64 },
  hashing,
  verification,
  processPeakRssMiB: Number((process.resourceUsage().maxRSS / 1_024).toFixed(2)),
}, null, 2));
