docker compose up -d postgres
Write-Host "PostgreSQL started on localhost:5432"
Write-Host "Start API: cd api-gateway; npm install; npm run dev"
Write-Host "Start Collector: cd collector-go; go mod tidy; go run ./..."
Write-Host "Start Web: cd web-vue3; npm install; npm run dev"
