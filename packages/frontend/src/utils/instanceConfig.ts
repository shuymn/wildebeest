import { Signal, createContextId } from '@builder.io/qwik'
import { InstanceConfig } from '@wildebeest/backend/types/configs'

/**
 * This context is used to pass the Wildebeest InstanceConfig down to any components that need it.
 */
export const InstanceConfigContext = createContextId<Signal<InstanceConfig>>('InstanceConfig')
