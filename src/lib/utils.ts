import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** shadcn/ui helper. shadcn components can be added with `pnpm dlx shadcn add <name>`; today the UI is built on Astryx. */
export const cn = (...inputs: ClassValue[]) => twMerge(clsx(inputs));
