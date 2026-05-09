import { createApp } from 'vue'
import { createPinia } from 'pinia'
import ElementPlus from 'element-plus'
import 'element-plus/dist/index.css'
import { router } from './router'
import App from './App.vue'
import './style.css'

createApp(App).use(createPinia()).use(ElementPlus).use(router).mount('#app')
