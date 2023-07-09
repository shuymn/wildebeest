export type KeyTypeOf<T, K extends keyof T> = { [P in K]: T[P] }[K]
export type SingleOrArray<T> = T | T[]
export type RequiredProps<T, K extends keyof T> = Omit<T, K> & Required<Pick<T, K>>
export type NonNullableProps<T, K extends keyof T> = Omit<T, K> & { [P in K]: NonNullable<T[P]> }
