import re
SUSPICIOUS = re.compile(re.escape("exec(base64.b64decode("))
