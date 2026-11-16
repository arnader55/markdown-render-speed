# SwiftMark — a faster marked

A dependency-free, from-scratch CommonMark 0.31.2 + GFM parser written to
return byte-for-byte the HTML that marked 18.1.3 renders with its default
options (GFM on), but faster.

`parse.js` exports `parse(markdown)`; `main.ts` reads every case from
`/input/cases.json`, renders each with `parse`, and writes
`/output/html.json`.

## Run

```sh
node main.ts
```

[![make.fun](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/arnader55/markdown-render-speed/rank.svg)](https://make.fun/bounty/markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/arnader55/markdown-render-speed/reward.svg)](https://make.fun/bounty/markdown-render-speed-02)
