import { type DefaultTreeAdapterMap, parse } from 'parse5'

// The web pages as a browser reads them: parse5, the spec HTML parser, with small queries, the text a reader gets
// (aria-hidden content left out) and a simplified accessible-name computation (accname: aria-labelledby, aria-label,
// a label, alt, then content).

export type Document = DefaultTreeAdapterMap['document']
export type Element = DefaultTreeAdapterMap['element']
type Node = DefaultTreeAdapterMap['node']
type Parent = DefaultTreeAdapterMap['parentNode']

export function parseHtml(html: string): Document {
	return parse(html)
}

const isElement = (node: Node): node is Element => 'tagName' in node

function childrenOf(node: Node): Node[] {
	if (isElement(node) && node.tagName === 'template') {
		return (node as DefaultTreeAdapterMap['template']).content.childNodes
	}
	return 'childNodes' in node ? (node as Parent).childNodes : []
}

// Every element under `root`, in document order.
export function elements(root: Node): Element[] {
	const found: Element[] = []
	const visit = (node: Node) => {
		for (const child of childrenOf(node)) {
			if (isElement(child)) {
				found.push(child)
			}
			visit(child)
		}
	}
	visit(root)
	return found
}

export function attr(element: Element, name: string): string | null {
	return element.attrs.find((a) => a.name === name)?.value ?? null
}

export function classes(element: Element): string[] {
	return (attr(element, 'class') ?? '').split(/\s+/).filter((c) => c !== '')
}

// Elements by tag name, optionally with a class.
export function query(root: Node, tag: string, className?: string): Element[] {
	return elements(root).filter((e) => e.tagName === tag && (className === undefined || classes(e).includes(className)))
}

export function one(root: Node, tag: string, className?: string): Element {
	const found = query(root, tag, className)
	if (found.length !== 1) {
		throw new Error(`expected one ${tag}${className === undefined ? '' : `.${className}`}, found ${found.length}`)
	}
	return found[0]!
}

export function byId(root: Node, id: string): Element | undefined {
	return elements(root).find((e) => attr(e, 'id') === id)
}

// The nearest ancestor (or the element itself) that passes `test`.
export function closest(element: Element, test: (e: Element) => boolean): Element | null {
	for (let node: Node | null = element; node !== null && isElement(node); node = node.parentNode as Node | null) {
		if (test(node)) {
			return node
		}
	}
	return null
}

const squash = (text: string) => text.replace(/\s+/g, ' ').trim()

// Content no reader gets (accname 1.2, step 2A): aria-hidden, the hidden attribute, and what is never rendered.
function hiddenFromReaders(element: Element): boolean {
	return (
		attr(element, 'aria-hidden') === 'true' ||
		attr(element, 'hidden') !== null ||
		['script', 'style', 'template'].includes(element.tagName)
	)
}

// The text a reader gets: aria-hidden subtrees, scripts and styles left out, whitespace collapsed.
export function text(node: Node): string {
	const parts: string[] = []
	const visit = (current: Node) => {
		for (const child of childrenOf(current)) {
			if (child.nodeName === '#text') {
				parts.push((child as DefaultTreeAdapterMap['textNode']).value)
			} else if (isElement(child)) {
				if (hiddenFromReaders(child)) {
					continue
				}
				visit(child)
			}
		}
	}
	visit(node)
	return squash(parts.join(''))
}

// The name content gives: text, the alt of images and the labels of labelled descendants.
function nameFromContent(node: Node): string {
	const parts: string[] = []
	for (const child of childrenOf(node)) {
		if (child.nodeName === '#text') {
			parts.push((child as DefaultTreeAdapterMap['textNode']).value)
		} else if (isElement(child)) {
			if (hiddenFromReaders(child) || CONTROLS.has(child.tagName)) {
				continue
			}
			const label = attr(child, 'aria-label')
			if (label !== null && label.trim() !== '') {
				parts.push(` ${label} `)
			} else if (child.tagName === 'img') {
				parts.push(attr(child, 'alt') ?? '')
			} else {
				parts.push(` ${nameFromContent(child)} `)
			}
		}
	}
	return squash(parts.join(''))
}

const CONTROLS = new Set(['input', 'select', 'textarea'])

// The accessible name of an element, as far as these pages need it.
export function accessibleName(element: Element, document: Document): string {
	const labelledBy = attr(element, 'aria-labelledby')
	if (labelledBy !== null) {
		return squash(
			labelledBy
				.split(/\s+/)
				.map((id) => {
					const target = byId(document, id)
					return target === undefined ? '' : nameFromContent(target)
				})
				.join(' ')
		)
	}
	const label = attr(element, 'aria-label')
	if (label !== null && label.trim() !== '') {
		return squash(label)
	}
	if (element.tagName === 'img') {
		return squash(attr(element, 'alt') ?? '')
	}
	if (CONTROLS.has(element.tagName)) {
		const id = attr(element, 'id')
		const labels = [
			...(id === null ? [] : query(document, 'label').filter((l) => attr(l, 'for') === id)),
			...[closest(element, (e) => e.tagName === 'label')].filter((l) => l !== null),
		]
		return squash(labels.map((l) => nameFromContent(l)).join(' '))
	}
	return nameFromContent(element)
}
