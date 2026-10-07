# Third-party notices

This package is BSD-3-Clause, inherited from upstream
`working-activity` (chimney, [@ccch1mneyyy](https://github.com/ccch1mneyyy)).
It also contains code adapted from the project below.

## pi-bar

- Source: <https://github.com/tianrendong/pi-bar> (`extensions/status-footer.ts`)
- License: MIT
- Copyright (c) 2026 Jenny Yu

Adapted in `src/narration.ts`: the progress-fragment prompt contract (human
developer framing, allowed/banned first-word lists, tense rules, good/bad
examples, the trailing hard-constraints block), the activity/prior-update
framing, and the cleanup chain (`stripLeakedScaffolding`,
`stripMarkdownFormatting`, `stripIdentifierLeaks`, `stripDanglingPrepositions`,
`stripSuccessSuffix`, `rewriteBannedFirstWord`) plus near-duplicate detection.
The terminal-UI concerns of the original are not used.

```
MIT License

Copyright (c) 2026 Jenny Yu

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
