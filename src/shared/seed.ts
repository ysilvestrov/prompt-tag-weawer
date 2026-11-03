import type { Category, LibrarySnapshot, PromptElement, PromptTemplate } from './types.ts';

export const SEED_IDS = {
  categories: {
    models: '00000000-0000-4000-8000-000000000001',
    clothing: '00000000-0000-4000-8000-000000000002',
    scenes: '00000000-0000-4000-8000-000000000003',
  },
  elements: {
    kateryna: '00000000-0000-4000-8000-000000000101',
    android: '00000000-0000-4000-8000-000000000102',
    jacket: '00000000-0000-4000-8000-000000000201',
    scarf: '00000000-0000-4000-8000-000000000202',
    alley: '00000000-0000-4000-8000-000000000301',
    studio: '00000000-0000-4000-8000-000000000302',
  },
  templates: {
    portrait: '00000000-0000-4000-8000-000000001001',
  },
} as const;

export function createSeedData(): LibrarySnapshot {
  const categories: Category[] = [
    {
      id: SEED_IDS.categories.models,
      name: 'Models',
      selectionMode: 'single',
      sortOrder: 0,
      updatedAt: 0,
      deletedAt: null,
    },
    {
      id: SEED_IDS.categories.clothing,
      name: 'Clothing',
      selectionMode: 'multi',
      sortOrder: 1,
      updatedAt: 0,
      deletedAt: null,
    },
    {
      id: SEED_IDS.categories.scenes,
      name: 'Scenes',
      selectionMode: 'single',
      sortOrder: 2,
      updatedAt: 0,
      deletedAt: null,
    },
  ];

  const elements: PromptElement[] = [
    {
      id: SEED_IDS.elements.kateryna,
      categoryId: SEED_IDS.categories.models,
      label: 'Kateryna K',
      value: '1girl, Kateryna K, highly detailed face',
      sortOrder: 0,
      updatedAt: 0,
      deletedAt: null,
    },
    {
      id: SEED_IDS.elements.android,
      categoryId: SEED_IDS.categories.models,
      label: 'Cyberpunk Android',
      value: '1boy, bionic chrome portrait, glowing optics',
      sortOrder: 1,
      updatedAt: 0,
      deletedAt: null,
    },
    {
      id: SEED_IDS.elements.jacket,
      categoryId: SEED_IDS.categories.clothing,
      label: 'Leather Jacket',
      value: 'black weathered leather jacket',
      sortOrder: 0,
      updatedAt: 0,
      deletedAt: null,
    },
    {
      id: SEED_IDS.elements.scarf,
      categoryId: SEED_IDS.categories.clothing,
      label: 'Neon Scarf',
      value: 'translucent neon fiber scarf',
      sortOrder: 1,
      updatedAt: 0,
      deletedAt: null,
    },
    {
      id: SEED_IDS.elements.alley,
      categoryId: SEED_IDS.categories.scenes,
      label: 'Rainy Alley',
      value: 'neon-lit rainy cyberpunk alley at night',
      sortOrder: 0,
      updatedAt: 0,
      deletedAt: null,
    },
    {
      id: SEED_IDS.elements.studio,
      categoryId: SEED_IDS.categories.scenes,
      label: 'Studio Rim Light',
      value: 'minimalist dark studio, dramatic rim lighting',
      sortOrder: 1,
      updatedAt: 0,
      deletedAt: null,
    },
  ];

  const templates: PromptTemplate[] = [
    {
      id: SEED_IDS.templates.portrait,
      name: 'Character Portrait',
      content: 'Portrait of [Models], wearing [Clothing] in [Scenes], [Camera Angle]',
      sortOrder: 0,
      updatedAt: 0,
      deletedAt: null,
    },
  ];

  return { categories, elements, templates };
}
