<template>
  <div class="wrap">
    <div class="card">
      <h1>Sharekhan Algo Trader</h1>
      <p class="sub">Runs locally on your machine. Login happens on Sharekhan's own page.</p>
      <button :disabled="loading" @click="login">
        {{ loading ? "Redirecting…" : "Login with Sharekhan" }}
      </button>
      <p v-if="error" class="error">{{ error }}</p>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from "vue";
import { api } from "../lib/api";

const loading = ref(false);
const error = ref("");

onMounted(() => {
  const params = new URLSearchParams(window.location.search);
  if (params.get("error")) {
    console.error(`[LOGIN] Arrived with error param: ${params.get("error")}`);
    error.value = `Login failed: ${params.get("error")}`;
  }
});

async function login() {
  console.log("[LOGIN] Login button clicked");
  loading.value = true;
  error.value = "";
  try {
    const { data } = await api.get("/auth/login-url");
    console.log("[LOGIN] Got login URL from backend, redirecting to Sharekhan…");
    window.location.href = data.url;
  } catch (err) {
    console.error("[LOGIN][FAIL]", err);
    error.value =
      err.response?.data?.error ||
      "Could not reach local backend. Is it running on :4000?";
    loading.value = false;
  }
}
</script>

<style scoped>
.wrap {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
}
.card {
  background: #171a21;
  padding: 2.5rem;
  border-radius: 12px;
  text-align: center;
  width: 340px;
  border: 1px solid #262a33;
}
h1 {
  font-size: 1.3rem;
  margin-bottom: 0.5rem;
}
.sub {
  color: #9aa0aa;
  font-size: 0.85rem;
  margin-bottom: 1.5rem;
}
button {
  background: #4f8cff;
  color: white;
  border: none;
  padding: 0.7rem 1.4rem;
  border-radius: 8px;
  font-size: 0.95rem;
  cursor: pointer;
  width: 100%;
}
button:disabled {
  opacity: 0.6;
  cursor: default;
}
.error {
  color: #ff6b6b;
  font-size: 0.85rem;
  margin-top: 1rem;
}
</style>
