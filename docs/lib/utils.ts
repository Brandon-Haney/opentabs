import { clsx } from 'clsx';
import { twMerge } from 'tailwind-merge';
import type { ClassNameValue } from 'tailwind-merge';

export const cn = (...classes: ClassNameValue[]) => twMerge(clsx(classes));
