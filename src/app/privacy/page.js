import Footer from "@/components/Footer";
import Link from "next/link";
import { getLocalizedPageMetadata } from "@/lib/seo";

export async function generateMetadata() {
  return getLocalizedPageMetadata("privacy");
}

export default function PrivacyPage() {
  return (
    <div className="flex min-h-dvh flex-col bg-wd-bg text-wd-text">
      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-12 sm:px-6 lg:px-8">
        <h1 className="mb-8 text-3xl font-bold tracking-tight text-white">
          Политика конфиденциальности NewVerse
        </h1>
        <p className="mb-8 text-sm text-wd-text-secondary">
          Настоящая Политика описывает, какие персональные данные обрабатывает NewVerse и для каких
          целей.
        </p>

        <div className="space-y-8 text-sm leading-relaxed text-wd-text-secondary">
          <section className="space-y-3">
            <h2 className="text-lg font-bold text-white">1. Оператор данных</h2>
            <p>
              Оператор: индивидуальный предприниматель (самозанятый) Троицкий Артемий Сергеевич, ИНН
              525914183000. Контакт для обращений по персональным данным:{" "}
              <a
                href="mailto:mrcheleng87@gmail.com"
                className="text-wd-secondary-text underline hover:text-white"
              >
                mrcheleng87@gmail.com
              </a>
              .
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-bold text-white">2. Какие данные обрабатываются</h2>
            <p>При регистрации и использовании сервиса могут обрабатываться:</p>
            <ul className="list-disc space-y-2 pl-5">
              <li>email и имя, указанные при создании аккаунта;</li>
              <li>данные, полученные от провайдера входа (например, Google);</li>
              <li>IP-адрес и технические журналы работы сервиса;</li>
              <li>сообщения в чатах с персонажами и ответы персонажей;</li>
              <li>сведения об оплатах в объёме, необходимом для оказания услуг.</li>
            </ul>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-bold text-white">3. Цели обработки</h2>
            <p>
              Данные обрабатываются для предоставления доступа к сервису NewVerse, исполнения{" "}
              <Link href="/offer" className="text-wd-secondary-text underline hover:text-white">
                публичной оферты
              </Link>
              , поддержки пользователей, предотвращения злоупотреблений и информирования о работе
              сервиса (с возможностью отказаться от рассылки).
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-bold text-white">4. Передача третьим лицам</h2>
            <p>
              Данные не передаются третьим лицам, за исключением случаев, предусмотренных
              законодательством РФ, а также платёжному партнёру и иным исполнителям, без которых
              невозможно оказать услугу (хостинг, авторизация, приём платежей), и рекламному
              партнёру в объёме, описанном в разделе 5.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-bold text-white">5. Показ рекламы</h2>
            <p>
              Пользователям без платной подписки NewVerse может показывать рекламные блоки под
              ответами персонажей. Рекламу предоставляет партнёр — ООО «Градиус» (ИНН 9703242433).
              Рекламный блок отделён от ответа персонажа, имеет пометку «Реклама» и не меняет текст
              ответа. Пользователям с платной подпиской реклама не показывается, и их данные партнёру
              не передаются.
            </p>
            <p>Для подбора рекламы и учёта показов партнёру могут передаваться:</p>
            <ul className="list-disc space-y-2 pl-5">
              <li>
                идентификаторы пользователя и диалога в виде необратимых хешей, по которым партнёр
                не может узнать исходные значения;
              </li>
              <li>технические сведения о показе: идентификатор рекламы, время и факт показа;</li>
              <li>
                в отдельных диалогах — текст ответа персонажа, из которого предварительно удалены
                имя пользователя и иные сведения о нём.
              </li>
            </ul>
            <p>
              Сообщения пользователя, email, имя, IP-адрес, cookie и идентификаторы устройства
              партнёру не передаются. Партнёр хранит полученные данные не более 14 дней, после чего
              удаляет их, и не вправе использовать их для обучения или настройки нейросетевых
              моделей.
            </p>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-bold text-white">6. Права пользователя</h2>
            <p>
              Пользователь вправе запросить уточнение, ограничение обработки или удаление своих
              персональных данных, направив обращение через{" "}
              <Link href="/support" className="text-wd-secondary-text underline hover:text-white">
                страницу поддержки
              </Link>
              .
            </p>
            <p className="text-xs text-wd-text-secondary/80">
              Редакция от 02.11.2026
            </p>
          </section>
        </div>
      </main>
      <Footer />
    </div>
  );
}
