// SPDX-License-Identifier: Apache-2.0
/**
 * XSS vectors from the DOMPurify test fixtures.
 *
 * Source: https://github.com/cure53/DOMPurify/blob/8cc5ae1388587f7a08cc099ff2a5e985f85d77c5/test/fixtures/expect.mjs
 * (commit 8cc5ae1388587f7a08cc099ff2a5e985f85d77c5, 2026-08-09; retrieved 2026-10-12)
 * Copyright (c) Cure53 and other contributors.
 *
 * DOMPurify is dual licensed under the Apache License 2.0 and the Mozilla Public License 2.0
 * ("(MPL-2.0 OR Apache-2.0)"); this file uses it under the Apache License, Version 2.0, a copy of which is
 * in the LICENSE file at the root of this repository and at https://www.apache.org/licenses/LICENSE-2.0.
 *
 * Changes: the `payload` values of the fixtures that exercise scripting, URLs, foreign content or mXSS were
 * extracted as string literals, deduplicated against the other vector files, limited to payloads that contain
 * markup and are at most 600 characters long, and capped at the first 90 matching entries. Only the vector
 * strings and their titles are kept.
 */

export const DOMPURIFY_VECTORS: readonly (readonly [name: string, payload: string])[] = [
  [
    "Avoid over-zealous stripping of SVG filter elements (see #144)",
    '<svg><defs><filter id="f1"><feGaussianBlur in="SourceGraphic" stdDeviation="15" /></filter></defs><rect width="90" height="90" stroke="green" stroke-width="3" fill="yellow" filter="url(#f1)" /></svg>',
  ],
  [
    "Keep the SVG dominant-baseline presentation attribute (see #1525)",
    '<svg><text dominant-baseline="middle">x</text></svg>',
  ],
  [
    "Keep the SVG text-orientation presentation attribute (see #1525)",
    '<svg><text text-orientation="upright">y</text></svg>',
  ],
  [
    "Keep the SVG pointer-events presentation attribute",
    '<svg><rect pointer-events="none" width="10" height="10"/></svg>',
  ],
  [
    "Keep the SVG vector-effect presentation attribute (see #447)",
    '<svg><circle vector-effect="non-scaling-stroke" cx="0" cy="0" r="30"/></svg>',
  ],
  [
    "safe usage of URI-like attribute values (see #135)",
    '<b href="javascript:alert(1)" title="javascript:alert(2)"></b>',
  ],
  [
    "src Attributes for IMG, AUDIO, VIDEO and SOURCE (see #131)",
    '<img src="data:,123"><audio src="data:,456"></audio><video src="data:,789"></video><source src="data:,012"><div src="data:,345">',
  ],
  [
    "DOM Clobbering against document.createElement() (see #47)",
    "<img src=x name=createElement><img src=y id=createElement>",
  ],
  ["DOM Clobbering against an empty cookie", "<img src=x name=cookie>"],
  ["JavaScript URIs using Unicode LS/PS I", "123<a href='\u2028javascript:alert(1)'>I am a dolphin!</a>"],
  ["JavaScript URIs using Unicode LS/PS II", "123<a href='\u2028javascript:alert(1)'>I am a dolphin too!</a>"],
  ["Image with data URI src", "<img src=data:image/jpeg,ab798ewqxbaudbuoibeqbla>"],
  ["Image with data URI src with whitespace", '<img src="\r\ndata:image/jpeg,ab798ewqxbaudbuoibeqbla">'],
  ["Image with JavaScript URI src (DoS on Firefox)", "<img src='javascript:while(1){}'>"],
  ["Link with data URI href", "<a href=data:,evilnastystuff>clickme</a>"],
  [
    "DOM clobbering XSS by @irsdl using attributes",
    '<form onmouseover=\'alert(1)\'><input name="attributes"><input name="attributes">',
  ],
  ["DOM clobbering: getElementById", "<img src=x name=getElementById>"],
  ["DOM clobbering: location", '<a href="#some-code-here" id="location">invisible'],
  [
    "onclick, onsubmit, onfocus; DOM clobbering: parentNode",
    "<div onclick=alert(0)><form onsubmit=alert(1)><input onfocus=alert(2) name=parentNode>123</form></div>",
  ],
  [
    "onsubmit, onfocus; DOM clobbering: nodeName",
    "<form onsubmit=alert(1)><input onfocus=alert(2) name=nodeName>123</form>",
  ],
  [
    "onsubmit, onfocus; DOM clobbering: nodeType",
    "<form onsubmit=alert(1)><input onfocus=alert(2) name=nodeType>123</form>",
  ],
  [
    "onsubmit, onfocus; DOM clobbering: children",
    "<form onsubmit=alert(1)><input onfocus=alert(2) name=children>123</form>",
  ],
  [
    "onsubmit, onfocus; DOM clobbering: attributes",
    "<form onsubmit=alert(1)><input onfocus=alert(2) name=attributes>123</form>",
  ],
  [
    "onsubmit, onfocus; DOM clobbering: removeChild",
    "<form onsubmit=alert(1)><input onfocus=alert(2) name=removeChild>123</form>",
  ],
  [
    "onsubmit, onfocus; DOM clobbering: removeAttributeNode",
    "<form onsubmit=alert(1)><input onfocus=alert(2) name=removeAttributeNode>123</form>",
  ],
  [
    "onsubmit, onfocus; DOM clobbering: setAttribute",
    "<form onsubmit=alert(1)><input onfocus=alert(2) name=setAttribute>123</form>",
  ],
  ["&gt;style&lt;", "<style>*{color: red}</style>"],
  ["mXSS Variation I", '<listing>&lt;img onerror="alert(1);//" src=x&gt;<t t></listing>'],
  ["mXSS Variation II", "<img src=x id/=' onerror=alert(1)//'>"],
  [
    "Textarea and comments enabling img element",
    "<textarea>@shafigullin</textarea><!--</textarea><img src=x onerror=alert(1)>-->",
  ],
  [
    "Img element inside noscript terminated inside comment",
    "<b><noscript><!-- </noscript><img src=x onerror=alert(1) --></noscript>",
  ],
  [
    "Img element inside noscript terminated inside attribute",
    '<b><noscript><a alt="</noscript><img src=x onerror=alert(1)>"></noscript>',
  ],
  [
    "Img element inside shadow DOM template",
    "<body><template><s><template><s><img src=x onerror=alert(1)>@shafigullin</s></template></s></template>",
  ],
  ["Low-range-ASCII obfuscated JavaScript URI", '<a href="\u0001java\u0003script:alert(1)">@shafigullin<a>'],
  [
    "Img inside style inside broken option element",
    "\u0001<option><style></option></select><b><img src=x onerror=alert(1)></style></option>",
  ],
  ["Iframe inside option element", "<option><iframe></select><b><script>alert(1)</script>"],
  ["Image after style to trick jQuery tag-completion", "<b><style><style/><img src=x onerror=alert(1)>"],
  [
    "Image after self-closing style to trick jQuery tag-completion",
    "<b><style><style////><img src=x onerror=alert(1)></style>",
  ],
  [
    "DOM clobbering attack using name=body",
    "<image name=body><image name=adoptNode>@mmrupp<image name=firstElementChild><svg onload=alert(1)>",
  ],
  ["DOM clobbering attack using activeElement", "<image name=activeElement><svg onload=alert(1)>"],
  [
    "DOM clobbering attack using name=body and injecting SVG + keygen",
    "<image name=body><img src=x><svg onload=alert(1); autofocus>, <keygen onfocus=alert(1); autofocus>",
  ],
  [
    "Bypass using multiple unknown attributes",
    '<div onmouseout="javascript:alert(/superevr/)" x=yscript: n>@superevr</div>',
  ],
  [
    "Bypass using event handlers and unknown attributes",
    '<button remove=me onmousedown="javascript:alert(1);" onclick="javascript:alert(1)" >@giutro',
  ],
  [
    "Bypass using DOM bugs when dealing with JS URIs in arbitrary attributes",
    '<a href="javascript:123" onclick="alert(1)">CLICK ME (bypass by @shafigullin)</a>',
  ],
  [
    "Bypass using DOM bugs when dealing with JS URIs in arbitrary attributes (II)",
    '<isindex x="javascript:" onmouseover="alert(1)" label="variation of bypass by @giutro">',
  ],
  ["Bypass using unknown attributes III", "<div wow=removeme onmouseover=alert(1)>text"],
  [
    "Bypass using unknown attributes IV",
    "<input x=javascript: autofocus onfocus=alert(1)><svg id=1 onload=alert(1)></svg>",
  ],
  [
    "Bypass using unknown attributes V",
    '<isindex src="javascript:" onmouseover="alert(1)" label="bypass by @giutro" />',
  ],
  ["dompurify 49", '<form action="javasc\nript:alert(1)"><button>XXX</button></form>'],
  [
    "dompurify 50",
    '<div id="1"><form id="foobar"></form><button form="foobar" formaction="javascript:alert(1)">X</button>//["\'`-->]]>]</div>',
  ],
  [
    "dompurify 51",
    '<div id="2"><meta charset="x-imap4-modified-utf7">&ADz&AGn&AG0&AEf&ACA&AHM&AHI&AGO&AD0&AGn&ACA&AG8Abg&AGUAcgByAG8AcgA9AGEAbABlAHIAdAAoADEAKQ&ACAAPABi//["\'`-->]]>]</div>',
  ],
  [
    "dompurify 52",
    '<div id="3"><meta charset="x-imap4-modified-utf7">&<script&S1&TS&1>alert&A7&(1)&R&UA;&&<&A9&11/script&X&>//["\'`-->]]>]</div>',
  ],
  [
    "dompurify 53",
    '<div id="4">0?<script>Worker("#").onmessage=function(_)eval(_.data)</script> :postMessage(importScripts(\'data:;base64,cG9zdE1lc3NhZ2UoJ2FsZXJ0KDEpJyk\'))//["\'`-->]]>]</div>',
  ],
  [
    "dompurify 54",
    "<div id=\"5\"><script>crypto.generateCRMFRequest('CN=0',0,0,null,'alert(5)',384,null,'rsa-dual-use')</script>//[\"'`-->]]>]</div>",
  ],
  ["dompurify 55", '<div id="6"><script>({set/**/$($){_/**/setter=$,_=1}}).$=alert</script>//["\'`-->]]>]</div>'],
  ["dompurify 56", '<div id="7"><input onfocus=alert(7) autofocus>//["\'`-->]]>]</div>'],
  ["dompurify 57", '<div id="8"><input onblur=alert(8) autofocus><input autofocus>//["\'`-->]]>]</div>'],
  [
    "dompurify 58",
    '<div id="9"><a style="-o-link:\'javascript:alert(9)\';-o-link-source:current">X</a>//["\'`-->]]>]</div>\n\n<div id="10"><video poster=javascript:alert(10)//></video>//["\'`-->]]>]</div>',
  ],
  [
    "dompurify 59",
    '<div id="11"><svg xmlns="http://www.w3.org/2000/svg"><g onload="javascript:alert(11)"></g></svg>//["\'`-->]]>]</div>',
  ],
  [
    "dompurify 60",
    '<div id="12"><body onscroll=alert(12)><br><br><br><br><br><br>...<br><br><br><br><input autofocus>//["\'`-->]]>]</div>',
  ],
  ["dompurify 61", '<div id="15"><script>({0:#0=alert/#0#/#0#(0)})</script>//["\'`-->]]>]</div>'],
  ["dompurify 62", '<div id="16">X<x style=`behavior:url(#default#time2)` onbegin=`alert(16)` >//["\'`-->]]>]</div>'],
  ["dompurify 63", '<div id="17"><?xml-stylesheet href="javascript:alert(17)"?><root/>//["\'`-->]]>]</div>'],
  ["dompurify 64", '<div id="18"><script xmlns="http://www.w3.org/1999/xhtml">alert(1)</script>//["\'`-->]]>]</div>'],
  ["dompurify 65", '<div id="19"><meta charset="x-mac-farsi">¼script ¾alert(19)//¼/script ¾//["\'`-->]]>]</div>'],
  [
    "dompurify 66",
    "<div id=\"20\"><script>ReferenceError.prototype.__defineGetter__('name', function(){alert(20)}),x</script>//[\"'`-->]]>]</div>",
  ],
  [
    "dompurify 67",
    "<div id=\"21\"><script>Object.__noSuchMethod__ = Function,[{}][0].constructor._('alert(21)')()</script>//[\"'`-->]]>]</div>",
  ],
  ["dompurify 68", '<div id="22"><input onblur=focus() autofocus><input>//["\'`-->]]>]</div>'],
  [
    "dompurify 69",
    '<div id="23"><form id=foobar onforminput=alert(23)><input></form><button form=test onformchange=alert(2)>X</button>//["\'`-->]]>]</div>',
  ],
  [
    "dompurify 70",
    '<div id="24">1<set/xmlns=`urn:schemas-microsoft-com:time` style=`behAvior:url(#default#time2)` attributename=`innerhtml` to=`<img/src="x"onerror=alert(24)>`>//["\'`-->]]>]</div>',
  ],
  ["dompurify 71", '<div id="25"><script src="#">{alert(25)}</script>;1//["\'`-->]]>]</div>'],
  [
    "dompurify 72",
    '<div id="27"><style>p[foo=bar{}*{-o-link:\'javascript:alert(27)\'}{}*{-o-link-source:current}*{background:red}]{background:green};</style>//["\'`-->]]>]</div><div id="28">1<animate/xmlns=urn:schemas-microsoft-com:time style=behavior:url(#default#time2)  attributename=innerhtml values=<img/src="."onerror=alert(28)>>//["\'`-->]]>]</div>',
  ],
  ["dompurify 73", '<div id="29"><link rel=stylesheet href=data:,*%7bx:expression(alert(29))%7d//["\'`-->]]>]</div>'],
  ["dompurify 74", '<div id="30"><style>@import "data:,*%7bx:expression(alert(30))%7D";</style>//["\'`-->]]>]</div>'],
  ["dompurify 75", '<div id="31"><frameset onload=alert(31)>//["\'`-->]]>]</div>'],
  ["dompurify 76", '<div id="32"><table background="javascript:alert(32)"></table>//["\'`-->]]>]</div>'],
  [
    "dompurify 77",
    '<div id="33"><a style="pointer-events:none;position:absolute;"><a style="position:absolute;" onclick="alert(33);">XXX</a></a><a href="javascript:alert(2)">XXX</a>//["\'`-->]]>]</div>',
  ],
  [
    "dompurify 78",
    '<div id="34">1<vmlframe xmlns=urn:schemas-microsoft-com:vml style=behavior:url(#default#vml);position:absolute;width:100%;height:100% src=test.vml#xss></vmlframe>//["\'`-->]]>]</div>',
  ],
  [
    "dompurify 79",
    '<div id="35">1<a href=#><line xmlns=urn:schemas-microsoft-com:vml style=behavior:url(#default#vml);position:absolute href=javascript:alert(35) strokecolor=white strokeweight=1000px from=0 to=1000 /></a>//["\'`-->]]>]</div>',
  ],
  [
    "dompurify 80",
    '<div id="36"><a style="behavior:url(#default#AnchorClick);" folder="javascript:alert(36)">XXX</a>//["\'`-->]]>]</div>',
  ],
  ["dompurify 81", '<div id="37"><!--<img src="--><img src=x onerror=alert(37)//">//["\'`-->]]>]</div>'],
  [
    "dompurify 82",
    '<div id="38"><comment><img src="</comment><img src=x onerror=alert(38)//">//["\'`-->]]>]</div><div id="39"><!-- up to Opera 11.52, FF 3.6.28 -->',
  ],
  ["dompurify 83", '<![><img src="]><img src=x onerror=alert(39)//">'],
  [
    "dompurify 84",
    '<!-- IE9+, FF4+, Opera 11.60+, Safari 4.0.4+, GC7+  -->\n<svg><![CDATA[><image xlink:href="]]><img src=x onerror=alert(2)//"></svg>//["\'`-->]]>]</div>',
  ],
  ["dompurify 85", '<div id="40"><style><img src="</style><img src=x onerror=alert(40)//">//["\'`-->]]>]</div>'],
  ["dompurify 86", '<div id="41"><li style=list-style:url() onerror=alert(41)></li>'],
  [
    "dompurify 87",
    "<div style=content:url(data:image/svg+xml,%3Csvg/%3E);visibility:hidden onload=alert(41)></div>//[\"'`-->]]>]</div>",
  ],
  [
    "dompurify 88",
    '<div id="42"><head><base href="javascript://"/></head><body><a href="/. /,alert(42)//#">XXX</a></body>//["\'`-->]]>]</div>',
  ],
  ["dompurify 89", '<div id="43"><?xml version="1.0" standalone="no"?>'],
  [
    "dompurify 90",
    '<html xmlns="http://www.w3.org/1999/xhtml">\n<head>\n<style type="text/css">\n@font-face {font-family: y; src: url("font.svg#x") format("svg");} body {font: 100px "y";}\n</style>\n</head>\n<body>Hello</body>\n</html>//["\'`-->]]>]</div>',
  ],
];
