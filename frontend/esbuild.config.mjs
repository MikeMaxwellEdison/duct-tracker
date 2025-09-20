import { build } from "esbuild";
await build({
  entryPoints: ["src/main.ts"],
  outdir: "../static",
  format: "esm",
  bundle: true,
  splitting: true,
  sourcemap: false,
  minify: true,
  target: ["es2022"],
  loader: { ".png":"file", ".jpg":"file" }
});