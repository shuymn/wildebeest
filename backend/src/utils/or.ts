export function or<T, U>(value: T | null, defaultValue: U, callback: (value: T) => U): U {
	if (value === null) {
		return defaultValue
	}
	return callback(value)
}
