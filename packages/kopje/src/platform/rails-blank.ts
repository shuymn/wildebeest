// Rails' String#blank? (/\A[[:space:]]*\z/, Onigmo's [[:space:]] being White_Space): U+0085 is blank, U+FEFF is not.
export function railsBlank(value: string): boolean {
	return /^\p{White_Space}*$/u.test(value)
}
