import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ChangeMap, splitPath } from "./change-map";
import type { Repo } from "../state";

const repo: Repo = {
  root: "/tmp/repo", name: "repo", branch: "main", agents: ["snail", "llama"],
  files: [{ path: "src/components/ui/very-long-directory-name/badge.tsx", status: "M", add: 3, del: 1 }],
};

test("splitPath dims the directory and keeps the filename whole", () => {
  expect(splitPath("src/a/b.tsx")).toEqual(["src/a", "b.tsx"]);
  expect(splitPath("README.md")).toEqual(["", "README.md"]);
});

test("change map renders a quiet list: chips, heat bars, no arrows or graph glyphs", () => {
  const html = renderToStaticMarkup(<ChangeMap repos={[repo]} onSelect={() => {}} />);
  expect(html).toContain("badge.tsx");
  expect(html).toContain("snail");
  expect(html).not.toContain("<svg");
  expect(html).not.toMatch(/[→←↗↘▲▼★✦✨]/);
  expect(html).not.toContain("hotspot");
  expect(html).not.toContain("bg-border");
  // The directory truncates from the left, so the path column needs a reversed inline direction.
  expect(html).toContain("direction:rtl");
  expect(html).toContain("grid-cols-[2rem_minmax(0,1fr)_2rem]");
});
