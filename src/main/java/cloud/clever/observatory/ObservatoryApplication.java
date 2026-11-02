package cloud.clever.observatory;

import static java.util.concurrent.TimeUnit.SECONDS;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.boot.autoconfigure.mongo.MongoClientSettingsBuilderCustomizer;
import org.springframework.context.annotation.Bean;

/**
 * The Observatory: a night sky where every celestial object is a MongoDB document.
 *
 * <p>Connection: Spring Boot reads {@code spring.data.mongodb.uri}, which points at the
 * {@code MONGODB_ADDON_URI} variable injected by the Clever Cloud MongoDB add-on.
 */
@SpringBootApplication
public class ObservatoryApplication {

    public static void main(String[] args) {
        SpringApplication.run(ObservatoryApplication.class, args);
    }

    /** Fail fast instead of hanging 30 s when the database is unreachable. */
    @Bean
    MongoClientSettingsBuilderCustomizer shortTimeouts() {
        return settings -> settings
                .applyToClusterSettings(cluster -> cluster.serverSelectionTimeout(5, SECONDS))
                .applyToSocketSettings(socket -> socket.connectTimeout(5, SECONDS).readTimeout(10, SECONDS));
    }
}
