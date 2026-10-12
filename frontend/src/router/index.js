import { createRouter, createWebHistory } from "vue-router";
import { api } from "../lib/api";
import Login from "../views/Login.vue";
import Dashboard from "../views/Dashboard.vue";

const routes = [
  { path: "/", redirect: "/login" },
  { path: "/login", component: Login, meta: { redirectIfAuthed: true } },
  { path: "/dashboard", component: Dashboard, meta: { requiresAuth: true } },
];

const router = createRouter({
  history: createWebHistory(),
  routes,
});

router.beforeEach(async (to) => {
  if (!to.meta.requiresAuth && !to.meta.redirectIfAuthed) return true;
  try {
    const { data } = await api.get("/auth/status");
    console.log(`[ROUTER] Guard for ${to.path} — backend says loggedIn=${data.loggedIn}`);
    if (to.meta.requiresAuth && !data.loggedIn) {
      console.warn(`[ROUTER] Blocking ${to.path} → redirecting to /login`);
      return "/login";
    }
    if (to.meta.redirectIfAuthed && data.loggedIn) {
      console.log(`[ROUTER] Already logged in → redirecting ${to.path} to /dashboard`);
      return "/dashboard";
    }
  } catch (err) {
    console.error(`[ROUTER][FAIL] Status check failed for ${to.path}:`, err.message);
    if (to.meta.requiresAuth) return "/login";
  }
  return true;
});

export default router;
