#!/usr/bin/env bash
set -e

echo "=== Verificando integração com portal_nginx ==="

if ! docker ps --format '{{.Names}}' | grep -q '^portal_nginx$'; then
  echo "Container portal_nginx não encontrado. Pulando configuração automática do Nginx."
  exit 0
fi

# 1. Garante que o portal_nginx esteja conectado na rede do docuware-ai-gateway
docker network connect reverse-proxy-network portal_nginx 2>/dev/null || true

# 2. Localiza os arquivos de configuração montados no portal_nginx
echo "Mapeamentos de volume do portal_nginx:"
docker inspect portal_nginx --format '{{range .Mounts}}{{.Source}} -> {{.Destination}}{{"\n"}}{{end}}'

# Procura arquivos .conf em /app/portal-dashboard ou outros diretórios montados no portal_nginx
CONF_FILES=$(docker inspect portal_nginx --format '{{range .Mounts}}{{.Source}}{{"\n"}}{{end}}' | grep -E '\.conf$|nginx' || true)

inject_into_conf() {
  local conf_file="$1"
  if [ ! -f "$conf_file" ]; then
    return 0
  fi

  if grep -q "location /ai-gateway" "$conf_file"; then
    echo "Rota /ai-gateway já está configurada em $conf_file"
    return 0
  fi

  if ! grep -q "location /" "$conf_file"; then
    return 0
  fi

  echo "Injetando bloco location /ai-gateway/ em $conf_file ..."
  cp "$conf_file" "${conf_file}.bak"

  python3 - "$conf_file" << 'PYEOF'
import sys, re

path = sys.argv[1]
with open(path, 'r', encoding='utf-8') as f:
    content = f.read()

block = """
    # Gateway Universal de IA Documental (DocuWare <-> OpenAI GPT-4o)
    location /ai-gateway/ {
        client_max_body_size 35M;
        proxy_pass http://docuware-ai-gateway:3014;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 90s;
        proxy_connect_timeout 90s;
        proxy_send_timeout 90s;
    }

    location = /ai-gateway {
        client_max_body_size 35M;
        proxy_pass http://docuware-ai-gateway:3014/ai-gateway;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 90s;
    }
"""

# Insere o bloco imediatamente antes de cada 'location / {'
new_content, count = re.subn(r'(\n\s*location\s+/\s*\{)', block + r'\1', content)

if count > 0:
    with open(path, 'w', encoding='utf-8') as f:
        f.write(new_content)
    print(f"Injetado com sucesso em {count} bloco(s) server de {path}")
else:
    print(f"Padrao 'location / {{' nao encontrado em {path}")
PYEOF

  # Testa se a sintaxe do Nginx no container continua válida
  if docker exec portal_nginx nginx -t; then
    docker exec portal_nginx nginx -s reload
    echo "portal_nginx recarregado com sucesso!"
  else
    echo "ERRO na validação do Nginx. Restaurando backup de $conf_file ..."
    mv "${conf_file}.bak" "$conf_file"
    docker exec portal_nginx nginx -s reload || true
  fi
}

# Varre todos os mounts do portal_nginx (arquivos ou diretórios)
while IFS= read -r mount_src; do
  [ -z "$mount_src" ] && continue
  if [ -f "$mount_src" ]; then
    inject_into_conf "$mount_src"
  elif [ -d "$mount_src" ]; then
    for f in "$mount_src"/*.conf "$mount_src"/conf.d/*.conf; do
      [ -f "$f" ] && inject_into_conf "$f"
    done
  fi
done < <(docker inspect portal_nginx --format '{{range .Mounts}}{{.Source}}{{"\n"}}{{end}}')

# Caso o arquivo de configuração não seja um volume montado, injeta diretamente dentro do container
if ! docker exec portal_nginx grep -rn "location /ai-gateway" /etc/nginx/ >/dev/null 2>&1; then
  echo "Configurando diretamente em /etc/nginx/conf.d/ dentro de portal_nginx..."
  docker exec -i portal_nginx sh -c '
    for f in /etc/nginx/conf.d/*.conf /etc/nginx/sites-enabled/* /etc/nginx/nginx.conf; do
      [ -f "$f" ] || continue
      if grep -q "location /" "$f" && ! grep -q "location /ai-gateway" "$f"; then
        cp "$f" "$f.bak"
        sed -i "/location \/ {/i \\    location /ai-gateway/ { client_max_body_size 35M; proxy_pass http://docuware-ai-gateway:3014; proxy_http_version 1.1; proxy_set_header Host \$host; proxy_set_header X-Real-IP \$remote_addr; proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for; proxy_set_header X-Forwarded-Proto \$scheme; proxy_read_timeout 90s; }" "$f"
      fi
    done
    nginx -t && nginx -s reload
  ' || true
fi
