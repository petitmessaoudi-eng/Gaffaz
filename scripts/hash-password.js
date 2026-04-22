const bcrypt = require('bcrypt');

const password = process.argv[2];

if (!password) {
  console.error('\nالاستخدام:');
  console.error('  node scripts/hash-password.js كلمة_المرور');
  console.error('\nمثال:');
  console.error('  node scripts/hash-password.js admin123\n');
  process.exit(1);
}

bcrypt.hash(password, 12).then(hash => {
  console.log('\n✅ Hash generated successfully:\n');
  console.log(hash);
  console.log('\nضع هذا في ملف .env:');
  console.log(`ADMIN_PASSWORD_HASH=${hash}\n`);
}).catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
