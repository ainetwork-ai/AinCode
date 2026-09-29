<h1 align="center">AinCode</h1>
<p align="center"><a href="https://ainetwork.ai">AI Network</a>의 오픈 소스 AI 코딩 에이전트.</p>
<p align="center">
  <a href="README.md">English</a> |
  <a href="README.ko.md">한국어</a>
</p>

---

AinCode는 오픈 소스 AI 코딩 에이전트 [OpenCode](https://github.com/anomalyco/opencode)를 AI Network가 fork한 프로젝트입니다.
upstream OpenCode를 계속 따라가면서 AI Network 브랜딩과 연동 기능을 추가합니다.

- 저장소: [github.com/ainetwork-ai/AinCode](https://github.com/ainetwork-ai/AinCode)
- Upstream: [github.com/anomalyco/opencode](https://github.com/anomalyco/opencode)

> [!NOTE]
> AinCode는 OpenCode 팀이 만들거나 OpenCode 팀과 제휴한 프로젝트가 아닙니다.
> 설정 파일, 환경 변수, 플러그인은 OpenCode와 호환됩니다
> (`opencode.json`, `~/.config/opencode`, `OPENCODE_*`). 따라서 upstream 문서를 그대로 참고할 수 있습니다.

### 설치

아직 AinCode 배포 패키지는 없습니다. [Bun](https://bun.sh)으로 소스에서 빌드해 실행하세요.

```bash
git clone https://github.com/ainetwork-ai/AinCode.git
cd AinCode
bun install
bun dev            # 현재 디렉터리에서 CLI/TUI 실행
bun dev --help     # `aincode` 명령어 도움말
```

### Agents

AinCode에는 `Tab` 키로 전환할 수 있는 두 가지 내장 에이전트가 있습니다.

- **build** - 기본값. 개발 작업을 위한 전체 권한 에이전트
- **plan** - 분석과 코드 탐색을 위한 읽기 전용 에이전트
  - 기본적으로 파일 편집 거부
  - bash 명령 실행 전에 권한 요청
  - 낯선 코드베이스를 탐색하거나 변경을 계획할 때 적합

복잡한 검색과 여러 단계로 이뤄진 작업을 위한 **general** 서브 에이전트도 포함돼 있습니다.
내부적으로 사용되며, 메시지에서 `@general`로 호출할 수 있습니다.

### 문서

AinCode는 upstream OpenCode 문서를 따릅니다: [opencode.ai/docs](https://opencode.ai/docs)

### Upstream 동기화

```bash
git remote add upstream https://github.com/anomalyco/opencode.git
git fetch upstream
git merge upstream/dev
```

### 기여하기

[ainetwork-ai/AinCode](https://github.com/ainetwork-ai/AinCode)에 PR을 보내기 전에 [기여 가이드](./CONTRIBUTING.md)를 읽어 주세요.

### 라이선스

upstream OpenCode와 같은 MIT 라이선스입니다. [LICENSE](./LICENSE)를 참고하세요.
