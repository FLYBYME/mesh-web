import { provider, type ProviderToken } from '../contribution/provider.js';
import type { HiveBindings } from './hives.js';

export const STORAGE: ProviderToken<HiveBindings> = provider<HiveBindings>('storage');
