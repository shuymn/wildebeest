export type SingleOrArray<T> = T | T[]
export type RequiredProps<T, K extends keyof T> = Omit<T, K> & Required<Pick<T, K>>
export type NonNullableProps<T, K extends keyof T> = Omit<T, K> & { [P in K]: NonNullable<T[P]> }
export type PartialProps<T, K extends keyof T> = Omit<T, K> & { [P in K]?: T[P] }
export type AwaitedOnce<T> = T extends Promise<infer U> ? U : T

export type Intersect<T, U> = Exclude<keyof T, keyof U> extends never
	? Exclude<keyof U, keyof T> extends never
		? T
		: { [P in Exclude<keyof U, keyof T>]: U[P] }
	: { [P in Exclude<keyof T, keyof U>]: T[P] }
