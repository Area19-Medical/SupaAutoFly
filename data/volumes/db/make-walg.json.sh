#!/bin/bash

separator=""

print_if_defined() {
  local config_name="$1"
  local var_name="$2"
  local var_value="${!var_name}"
  if [ -n "$var_value" ]; then
    echo -n "$separator  \"$config_name\": \"$var_value\""
    separator=$',\n'
  fi
}

PGUSER=${WALG_PGUSER:-supabase_admin}

echo "{"
print_if_defined "WALG_S3_PREFIX" "WALG_S3_PREFIX"
print_if_defined "AWS_REGION" "WALG_S3_REGION"
print_if_defined "AWS_ENDPOINT" "WALG_S3_ENDPOINT"
print_if_defined "AWS_ACCESS_KEY_ID" "WALG_S3_ACCESS_KEY_ID"
print_if_defined "AWS_SECRET_ACCESS_KEY" "WALG_S3_SECRET_ACCESS_KEY"
print_if_defined "WALG_SSH_PREFIX" "WALG_SSH_PREFIX"
print_if_defined "SSH_PORT" "WALG_SSH_PORT"
print_if_defined "SSH_USERNAME" "WALG_SSH_USERNAME"
print_if_defined "SSH_PRIVATE_KEY_PATH" "WALG_SSH_PRIVATE_KEY_PATH"
print_if_defined "WALG_COMPRESSION_METHOD" "WALG_COMPRESSION_METHOD"
print_if_defined "WALG_LIBSODIUM_KEY" "WALG_LIBSODIUM_KEY"
print_if_defined "WALG_LIBSODIUM_KEY_TRANSFORM" "WALG_LIBSODIUM_KEY_TRANSFORM"
print_if_defined "PGUSER" "PGUSER"
echo $'\n}'
