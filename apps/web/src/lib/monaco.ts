// Local Monaco (no CDN) so diffs work offline. Only syntax highlighting is loaded — no language services.
import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
import "monaco-editor/esm/vs/editor/edcore.main";
import "monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution";
import "monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution";
import "monaco-editor/esm/vs/basic-languages/python/python.contribution";
import "monaco-editor/esm/vs/basic-languages/go/go.contribution";
import "monaco-editor/esm/vs/basic-languages/rust/rust.contribution";
import "monaco-editor/esm/vs/basic-languages/java/java.contribution";
import "monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution";
import "monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution";
import "monaco-editor/esm/vs/basic-languages/css/css.contribution";
import "monaco-editor/esm/vs/basic-languages/html/html.contribution";
import "monaco-editor/esm/vs/basic-languages/shell/shell.contribution";
import "monaco-editor/esm/vs/basic-languages/ruby/ruby.contribution";
import "monaco-editor/esm/vs/basic-languages/dockerfile/dockerfile.contribution";
import "monaco-editor/esm/vs/basic-languages/ini/ini.contribution";
import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import { loader } from "@monaco-editor/react";

(self as unknown as { MonacoEnvironment: unknown }).MonacoEnvironment = { getWorker: () => new EditorWorker() };

monaco.languages.register({ id: "json" });

const THEMES = {
  light: {
    base: "vs" as const,
    rules: [
      { token: "comment", foreground: "6E6E73", fontStyle: "italic" },
      { token: "keyword", foreground: "1D1D1F", fontStyle: "bold" },
      { token: "string", foreground: "1A7F37" },
      { token: "number", foreground: "9A6700" },
      { token: "type", foreground: "424245" },
    ],
    colors: {
      "editor.background": "#FFFFFF",
      "editor.foreground": "#1D1D1F",
      "editorLineNumber.foreground": "#C7C7CC",
      "editorLineNumber.activeForeground": "#6E6E73",
      "editor.lineHighlightBackground": "#F5F5F7",
      "editor.selectionBackground": "#D2D2D7",
      "editorGutter.background": "#FFFFFF",
      "diffEditor.insertedTextBackground": "#1A7F3726",
      "diffEditor.removedTextBackground": "#D1242F26",
      "diffEditor.insertedLineBackground": "#1A7F3712",
      "diffEditor.removedLineBackground": "#D1242F12",
      "scrollbarSlider.background": "#D2D2D788",
      "editorOverviewRuler.border": "#00000000",
    },
  },
  dark: {
    base: "vs-dark" as const,
    rules: [
      { token: "comment", foreground: "98989D", fontStyle: "italic" },
      { token: "keyword", foreground: "F5F5F7", fontStyle: "bold" },
      { token: "string", foreground: "3FB950" },
      { token: "number", foreground: "D29922" },
      { token: "type", foreground: "C7C7CC" },
    ],
    colors: {
      "editor.background": "#161617",
      "editor.foreground": "#F5F5F7",
      "editorLineNumber.foreground": "#48484A",
      "editorLineNumber.activeForeground": "#98989D",
      "editor.lineHighlightBackground": "#232325",
      "editor.selectionBackground": "#3A3A3C",
      "editorGutter.background": "#161617",
      "diffEditor.insertedTextBackground": "#3FB95033",
      "diffEditor.removedTextBackground": "#F8514933",
      "diffEditor.insertedLineBackground": "#3FB95014",
      "diffEditor.removedLineBackground": "#F8514914",
      "scrollbarSlider.background": "#3A3A3C88",
      "editorOverviewRuler.border": "#00000000",
    },
  },
};

/** One theme name, "causalci", redefined to match the Mac light/dark setting. */
const scheme = typeof window !== "undefined" ? window.matchMedia("(prefers-color-scheme: dark)") : null;
function applyTheme() {
  const t = scheme?.matches ? THEMES.dark : THEMES.light;
  monaco.editor.defineTheme("causalci", { base: t.base, inherit: true, rules: t.rules, colors: t.colors });
  monaco.editor.setTheme("causalci");
}
applyTheme();
scheme?.addEventListener("change", applyTheme);

/** Editor font: the system monospace. */
export const EDITOR_FONT = '"SF Mono", ui-monospace, Menlo, Monaco, monospace';

loader.config({ monaco });
export { monaco };
