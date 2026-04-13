# Info

You can edit the file `start_workers.sh` and use it for start your workers with a script.

# 

Connect to the remote server and start the workers

```
tmux new-session -d -s worker ./start_workers_n97_1.sh
tmux attach -t worker
```
