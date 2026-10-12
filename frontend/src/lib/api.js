import axios from "axios";

export const api = axios.create({
  baseURL: "http://localhost:4000/api",
});

// [API] trace every request/response so a failure's origin (and the
// exact backend error message) is visible in the browser console
// without needing to add logging inside every component by hand.
api.interceptors.request.use((config) => {
  console.log(`[API] --> ${config.method?.toUpperCase()} ${config.url}`, config.params || config.data || "");
  return config;
});

api.interceptors.response.use(
  (response) => {
    console.log(`[API][OK] <-- ${response.config.method?.toUpperCase()} ${response.config.url} ${response.status}`);
    return response;
  },
  (error) => {
    const cfg = error.config || {};
    console.error(
      `[API][FAIL] <-- ${cfg.method?.toUpperCase()} ${cfg.url} ${error.response?.status ?? "(no response)"}`,
      error.response?.data || error.message
    );
    return Promise.reject(error);
  }
);
