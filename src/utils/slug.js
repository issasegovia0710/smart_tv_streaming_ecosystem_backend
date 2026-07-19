import slugify from 'slugify';

export function toSlug(value) {
  return slugify(String(value ?? ''), {
    lower: true,
    strict: true,
    locale: 'es',
    trim: true,
  });
}
