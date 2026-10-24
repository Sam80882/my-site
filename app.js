const form = document.getElementById('task-form');
const input = document.getElementById('task-input');
const list = document.getElementById('task-list');
const summary = document.getElementById('summary');
const filterButtons = document.querySelectorAll('.filters button');

let tasks = load();
let filter = 'all';

function load() {
  try {
    return JSON.parse(localStorage.getItem('tasks')) || [];
  } catch {
    return [];
  }
}

function save() {
  try {
    localStorage.setItem('tasks', JSON.stringify(tasks));
  } catch {}
}

function render() {
  list.innerHTML = '';
  const visible = tasks.filter(t =>
    filter === 'all' ? true : filter === 'done' ? t.done : !t.done
  );

  for (const task of visible) {
    const li = document.createElement('li');
    if (task.done) li.classList.add('done');

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = task.done;
    checkbox.addEventListener('change', () => {
      task.done = checkbox.checked;
      update();
    });

    const text = document.createElement('span');
    text.textContent = task.text;

    const del = document.createElement('button');
    del.className = 'delete';
    del.textContent = 'Delete';
    del.addEventListener('click', () => {
      tasks = tasks.filter(t => t.id !== task.id);
      update();
    });

    li.append(checkbox, text, del);
    list.append(li);
  }

  const remaining = tasks.filter(t => !t.done).length;
  summary.textContent = `${remaining} of ${tasks.length} task(s) remaining`;
}

function update() {
  save();
  render();
}

form.addEventListener('submit', e => {
  e.preventDefault();
  const text = input.value.trim();
  if (!text) return;
  tasks.push({ id: Date.now(), text, done: false });
  input.value = '';
  update();
});

filterButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    filter = btn.dataset.filter;
    filterButtons.forEach(b => b.classList.toggle('active', b === btn));
    render();
  });
});

render();
