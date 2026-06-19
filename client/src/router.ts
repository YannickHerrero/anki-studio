import { createRouter, createWebHashHistory } from 'vue-router';

export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', name: 'home', component: () => import('./views/HomeView.vue') },
    { path: '/upload', name: 'upload', component: () => import('./views/UploadView.vue') },
    { path: '/youtube', name: 'youtube', component: () => import('./views/YouTubeView.vue') },
    { path: '/sessions', name: 'sessions', component: () => import('./views/SessionsView.vue') },
    { path: '/known', name: 'known', component: () => import('./views/KnownWordsView.vue') },
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
      meta: { fullWidth: true },
    },
    {
      path: '/session/:sid/export',
      name: 'export',
      component: () => import('./views/ExportView.vue'),
      props: true,
    },
  ],
});
