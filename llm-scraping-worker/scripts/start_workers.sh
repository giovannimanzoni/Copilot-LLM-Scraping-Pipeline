#!/bin/bash
cd ..

eval "$(/home/app1/miniconda3/bin/conda shell.bash hook)"
source $(conda info --base)/etc/profile.d/conda.sh
conda activate ./envSFTW

trap 'kill 0' INT TERM

sudo mkdir -p /mnt/tmpfs_repos
sudo mount -t tmpfs -o size=6G tmpfs /mnt/tmpfs_repos 2>/dev/null || true

mkdir -p data

while true; do
    ./envSFTW/bin/python -m worker
    EXIT_CODE=$?
    # 0 = clean exit (all phases done); 1 = fatal config error (name taken / invalid params)
    if [ "$EXIT_CODE" -eq 0 ] || [ "$EXIT_CODE" -eq 1 ]; then
        break
    fi
    echo "[restart] Worker exited with code $EXIT_CODE (OOM or crash) — restarting in 15 s..."
    sleep 15
done

wait
