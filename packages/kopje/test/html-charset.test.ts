import { describe, expect, it } from "vitest";

import { charsetFromContent, chooseCharset, prescanCharset } from "../src/platform/html-charset";

const ascii = (text: string) => new TextEncoder().encode(text);

describe("chooseCharset", () => {
  it("takes a BOM over the header and the meta", () => {
    const page = ascii('﻿<meta charset="shift_jis">');
    expect(chooseCharset(page, "windows-1252")).toEqual({ label: "utf-8", source: "bom", bomLength: 3 });
    expect(chooseCharset(new Uint8Array([0xfe, 0xff, 0, 0x3c]), "utf-8")).toMatchObject({ label: "utf-16be" });
    expect(chooseCharset(new Uint8Array([0xff, 0xfe, 0x3c, 0]), null)).toMatchObject({ label: "utf-16le" });
  });

  it("takes a valid header charset over the meta, under its canonical name", () => {
    expect(chooseCharset(ascii('<meta charset="euc-jp">'), "SJIS")).toEqual({
      label: "shift_jis",
      source: "header",
      bomLength: 0,
    });
  });

  it("passes an invalid header charset to the meta, and an invalid meta to UTF-8", () => {
    expect(chooseCharset(ascii('<meta charset="euc-jp">'), "no-such-charset")).toMatchObject({
      label: "euc-jp",
      source: "meta",
    });
    expect(chooseCharset(ascii('<meta charset="replacement">'), "iso-2022-kr")).toEqual({
      label: "utf-8",
      source: "default",
      bomLength: 0,
    });
  });
});

describe("prescanCharset", () => {
  it.each([
    ['<meta charset="Shift_JIS">', "shift_jis"],
    ["<meta charset='euc-jp'>", "euc-jp"],
    ["<meta charset=gbk>", "gbk"],
    ["<META CHARSET=KOI8-R>", "koi8-r"],
    ["<meta/charset=big5>", "big5"],
    ['<meta http-equiv="Content-Type" content="text/html; charset=euc-kr">', "euc-kr"],
    ["<meta content=\"text/html; charset='iso-8859-2'\" http-equiv=content-type>", "iso-8859-2"],
    ['<meta charset="utf-16le">', "utf-8"],
    ['<meta charset="utf-16">', "utf-8"],
    ['<meta charset="x-user-defined">', "windows-1252"],
    ['<meta charset="shift_jis" charset="euc-jp">', "shift_jis"],
    ['<!-->\n<meta charset="gbk">', "gbk"],
    ['<p title="x>y"><meta charset="big5">', "big5"],
  ])("reads %j as %s", (page, label) => {
    expect(prescanCharset(ascii(page))).toBe(label);
  });

  it.each([
    ["a meta inside a comment", '<!-- <meta charset="shift_jis"> -->'],
    ["a meta inside a quoted attribute of another tag", '<div title="<meta charset=shift_jis>">'],
    ["a content charset without the pragma", '<meta content="text/html; charset=shift_jis">'],
    ["a character reference in the label", '<meta charset="&#115;hift_jis">'],
    ["an invalid label", '<meta charset="no-such-charset">'],
    ["a meta past the first 1,024 bytes", `${" ".repeat(1024)}<meta charset="shift_jis">`],
    ["a meta cut at the end of the prescan", `${" ".repeat(1000)}<meta charset="shift_jis`],
    ["a <metadata> tag", '<metadata charset="shift_jis">'],
    ["an unterminated comment", '<!-- <meta charset="shift_jis">'],
  ])("finds nothing in %s", (_label, page) => {
    expect(prescanCharset(ascii(page))).toBeNull();
  });

  it("reads only raw bytes: a non-ASCII byte in a label is not a letter", () => {
    expect(prescanCharset(new Uint8Array([...ascii('<meta charset="shift'), 0xff, ...ascii('jis">')]))).toBeNull();
  });
});

describe("charsetFromContent", () => {
  it.each([
    ["text/html; charset=utf-8", "utf-8"],
    ['text/html;charset = "euc-jp" ', "euc-jp"],
    ["charset='gbk'", "gbk"],
    ["text/html; charset=big5;x=y", "big5"],
    ["charsetcharset=koi8-r", "koi8-r"],
    ['text/html; charset="unclosed', null],
    ["text/html; charset=", null],
    ["text/html", null],
  ])("reads %j as %j", (content, label) => {
    expect(charsetFromContent(content)).toBe(label);
  });
});
