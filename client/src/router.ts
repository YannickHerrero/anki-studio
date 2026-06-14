import { createRouter, createWebHashHistory } from 'vue-router';

export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', name: 'upload', component: () => import('./views/UploadView.vue') },
    { path: '/settings', name: 'settings', component: () => import('./views/SettingsView.vue') },
    {
      path: '/session/:sid/processing',
      name: 'processing',
      component: () => import('./views/ProcessingView.vue'),
      props: true,
    },
    {
      path: '/session/:sid/review',
      name: 'review',
      component: () => import('./views/ReviewView.vue'),
      props: true,
    },
    {
      path: '/session/:sid/export',
      name: 'export',
      component: () => import('./views/ExportView.vue'),
      props: true,
    },
  ],
});
