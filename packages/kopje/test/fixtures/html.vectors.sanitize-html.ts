// SPDX-License-Identifier: MIT
/**
 * XSS vectors from the sanitize-html tests.
 *
 * Source: https://github.com/apostrophecms/sanitize-html/blob/ab34262bbae11c3b3976b7a7a292db4bfd2918eb/test/test.js
 * (commit ab34262bbae11c3b3976b7a7a292db4bfd2918eb, 2026-02-20; retrieved 2026-10-12)
 *
 * Changes: the string literal inputs of `sanitizeHtml(...)` calls that exercise scripting, URLs or markup
 * reconstruction were extracted as string literals, deduplicated against the other vector files, limited to
 * payloads that contain markup and are at most 600 characters long, and capped at the first 40 matching entries.
 * Only the vector strings and their titles are kept.
 *
 * Copyright (c) 2013, 2014, 2015 P'unk Avenue LLC
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
 * documentation files (the "Software"), to deal in the Software without restriction, including without
 * limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the
 * Software, and to permit persons to whom the Software is furnished to do so, subject to the following
 * conditions:
 *
 * The above copyright notice and this permission notice shall be included in all copies or substantial portions
 * of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED
 * TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL
 * THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF
 * CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
 * DEALINGS IN THE SOFTWARE.
 */

export const SANITIZE_HTML_VECTORS: readonly (readonly [name: string, payload: string])[] = [
  ["sanitizeHtml 1", 'before <img src="test.png" /> after'],
  ["sanitizeHtml 2", '<a href="foo.html" whizbang="whangle">foo</a>'],
  ["sanitizeHtml 3", '<img src="foo.jpg"><p>Whee<p>Again<p>Wow<b>cool</b>'],
  [
    "sanitizeHtml 4",
    '<a href="http://google.com">google</a><a href="https://google.com">https google</a><a href="ftp://example.com">ftp</a><a href="mailto:test@test.com">mailto</a><a href="/relative.html">relative</a><a href="javascript:alert(0)">javascript</a>',
  ],
  [
    "sanitizeHtml 5",
    '<A HREF="http://google.com">google</a><a href="HTTPS://google.com">https google</a><a href="ftp://example.com">ftp</a><a href="mailto:test@test.com">mailto</a><a href="/relative.html">relative</a><a href="javascript:alert(0)">javascript</a>',
  ],
  ["sanitizeHtml 6", '<script>alert("ruhroh!");</script><p>Paragraph</p>'],
  ["sanitizeHtml 7", "<style>.foo { color: blue; }</style><p>Paragraph</p>"],
  ["sanitizeHtml 8", "<p><!-- Blah blah -->Whee</p>"],
  [
    "sanitizeHtml 9",
    '<a href="&#106;&#97;&#118;&#97;&#115;&#99;&#114;&#105;&#112;&#116;&#58;&#97;&#108;&#101;&#114;&#116;&#40;&#39;&#88;&#83;&#83;&#39;&#41;">Hax</a>',
  ],
  ["sanitizeHtml 10", "<a href=\"JAVASCRIPT:alert('foo')\">Hax</a>"],
  ["sanitizeHtml 11", "<a href=\"java<!-- -->script:alert('foo')\">Hax</a>"],
  ["sanitizeHtml 12", '<a href="awesome.html#this:stuff">Hi</a>'],
  ["sanitizeHtml 13", "<a href=\"java\u0000&#14;\t\r\n script:alert('foo')\">Hax</a>"],
  ["sanitizeHtml 14", "<a href=\"java&#0000001script:alert('foo')\">Hax</a>"],
  ["sanitizeHtml 15", "<a href=\"java&#0000000script:alert('foo')\">Hax</a>"],
  ["sanitizeHtml 16", '<a href="http://google.com/">Hi</a>'],
  ["sanitizeHtml 17", '<a href="hello.html">Hi</a>'],
  ["sanitizeHtml 18", '<a href="http://somelink">some text</a>'],
  ["sanitizeHtml 19", '<a href="http://somelink"></a>'],
  ["sanitizeHtml 20", '<a href="http://somelink">some initial text</a>'],
  ["sanitizeHtml 21", '<p>This is <a href="http://www.linux.org"></a><br/>Linux</p>'],
  ["sanitizeHtml 22", '<p>12<a href="http://www.linux.org"><br/>3<br></a><audio>4</audio></p>'],
  ["sanitizeHtml 23", '<p><a href="http://www.linux.org"><br/></a></p>'],
  ["sanitizeHtml 24", 'I love <a href="www.linux.org" target="_hplink">Linux</a> OS'],
  [
    "sanitizeHtml 25",
    '<p>These links <a href="javascript:alert(123)">hack</a> <a href="data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==">more hack</a> have disallowed href protocols</p>',
  ],
  ["sanitizeHtml 26", '<img src="data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==" />'],
  [
    "sanitizeHtml 27",
    '<img src="data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==" /><a href="https://www.example.com"></a>',
  ],
  ["sanitizeHtml 28", "<IMG SRC= onmouseover=\"alert('XSS');\">"],
  ["sanitizeHtml 29", "<style></style>"],
  [
    "sanitizeHtml 30",
    '<table bgcolor="1" align="left" notlisted="0"><img src="1.gif" align="center" alt="not listed too"/></table>',
  ],
  ["sanitizeHtml 31", '<a href="test.html">test</a>'],
  ["sanitizeHtml 32", '<a href="test.html">blah</a>'],
  ["sanitizeHtml 33", '<<img src="javascript:evil"/>img src="javascript:evil"/>'],
  ["sanitizeHtml 34", '<<a href="javascript:evil"/>a href="javascript:evil"/>'],
  ["sanitizeHtml 35", '<div>"normal text"</div><script>"this is code"</script>'],
  ["sanitizeHtml 36", '<div>"normal text"</div><style>body { background-image: url("image.test"); }</style>'],
  ["sanitizeHtml 37", '<script>alert("&quot;This is cool but just ironically so I quoted it&quot;")</script>'],
  ["sanitizeHtml 38", "!<textarea>&lt;/textarea&gt;&lt;svg/onload=prompt`xs`&gt;</textarea>!"],
  ["sanitizeHtml 39", '<a href="//cnn.com/example">test</a>'],
  ["sanitizeHtml 40", '<a href="/\\cnn.com/example">test</a>'],
];
